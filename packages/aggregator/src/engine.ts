/**
 * @file engine.ts
 *
 * Core aggregation engine. Exports two things:
 *
 * - **`Store`** - the internal key-value store that accumulates results across pipeline stages. Exposed for testing; not part of the public library API.
 *
 * - **`RedisAggregator`** - the fluent builder class.
 * 
 * Users construct a pipeline by chaining methods (`.push()`, `.commit()`, `.derive()`, etc.) and then execute it with `.windup()`
 * or
 * Users construct a pipeline by passing an array of pipeline stages to `.aggregate()` / `.aggregateSafe()`.
 *
 * **Mental model:**
 * ```
 * RedisAggregator
 *   .push(redis_get ...)     - queue a Redis command
 *   .push(redis_hgetall ...) - queue another
 *   .commit()                - flush queued commands as one pipeline batch
 *   .derive('fullName', ...) - compute a value from the results
 *   .validate(...)           - assert a condition
 *   .windup(store => ...)    - assemble and return the final value
 * ```
 *
 * Each chaining method creates a **new** `RedisAggregator` instance rather than mutating `this`.
 * This makes the builder safe to fork and reuse without cross-contamination between branches of the chain.
 */

import { logForDebug } from "~/shared/lib/utils";
import { Redis } from "ioredis";
import { AggregatorConfig, AggregatorStore, BranchStage, DeriveStage, ExtendedRedisStage, Stage, TransformStage, TypedStore, ValidationStage, WindupStage } from "./types/aggregator";
import { executeStack, mapResults } from "./executor.js";
import { branchStage, deriveStage, transformStage, validationStage } from "./stages";
import { isRedisJsonStage, isRedisStage, validateStages } from "./tools";
import { ExplainResult } from "./types";
import { explainStages } from "./explain";
import { GeneralReturnType } from "~/shared/types";


type Context = {
    store: TypedStore,
    stages: Stage<any>[],
    signal: AbortSignal | undefined,
}

/**
 * Internal key-value store that accumulates results as the pipeline runs.
 *
 * The store is the single source of truth for all inter-stage communication:
 * - `redis_*` / `json_*` results are written here by `mapResults` after each `commit`.
 * - `derive` and `transform` stages write computed values here.
 * - `validate`, `branch`, and `windup` stages read from here via `readonly()`.
 *
 * **User-facing surface:**
 * Consumers only ever receive a `ReadonlyStore` (via `store.readonly()`) inside callbacks.
 * Direct mutation is intentionally inaccessible outside this file.
 *
 * @internal
 */

class Store {

    // Raw data record. Kept as a plain object for fast property access.
    data: Record<string, unknown>;

    constructor(initial?: Record<string, unknown>) {
        this.data = initial ? { ...initial } : {};
    }

    /** Writes `value` at `key`, overwriting any existing entry. */
    set(key: string, value: unknown): void {
        this.data[key] = value;
    }

    /**
     * Resets the store to an empty state.
     * Called in `finally` blocks after each top-level aggregation so memory is not held between calls on a shared aggregator instance.
     */
    clear(): void {
        this.data = {};
    }

    /** Returns the value stored at `key`, cast to `T`. Returns `undefined` if absent. */
    get<T = unknown>(key: string): T {
        return this.data[key] as T;
    }

    /** Returns `true` if `key` exists in the store. */
    has(key: string): boolean {
        return key in this.data;
    }

    /** Returns all keys currently in the store. */
    keys(): string[] {
        return Object.keys(this.data);
    }

    /** Returns all values currently in the store. */
    values(): unknown[] {
        return Object.values(this.data);
    }

    /** Returns all `[key, value]` pairs as an array. */
    entries(): [string, unknown][] {
        return Object.entries(this.data);
    }

    /**
     * Returns a `ReadonlyStore` interface - a subset of `Store` with only read methods exposed.
     * This is what consumers receive inside callbacks to prevent accidental (or intentional) store mutation from user code.
     */
    readonly(): AggregatorStore {
        return {
            has: (k) => this.has(k),
            keys: () => this.keys(),
            values: () => this.values(),
            entries: () => this.entries(),
            get: (k) => this.get(k),
        };
    }
}

/**
 * Fluent builder and executor for Redis aggregation pipelines.
 *
 * Construct a pipeline by chaining stage methods and then execute it with `.windup()`, `.aggregate()`, or `.aggregateSafe()`.
 * Alternatively, inspect the pipeline without executing with `.explain()`.
 *
 * **Immutable chain - safe to fork:**
 * Every chaining method (`.push()`, `.commit()`, `.derive()`, etc.) returns a **new** `RedisAggregator` instance.
 * 
 * The original instance is unchanged, so you can branch a shared base:
 * 
 * ```ts
 * const base = aggregator.push({ method: 'redis_get', key: 'user:1', ref: 'user' }).commit();
 * const withRole  = base.derive('role', store => store.get<User>('user').role);
 * const withEmail = base.derive('email', store => store.get<User>('user').email);
 * ```
 *
 * **Execution rules**:
 * 1. The first stage must be a `redis_*` or `json_*` stage.
 * 2. Every `redis_*`, `json_*`, or `branch` stage must be followed by a `commit`.
 * 3. The last stage must be `windup`. There must be exactly one.
 */

export class RedisAggregator {

    /**
     * Store snapshot carried along the chain so pre-seeded values (if any) can be passed into `.windup()`.
     * In practice this is almost always empty at chain-build time.
     * 
     * @private
     */

    private store = new Store();

    /**
     * Accumulated stages for this builder instance.
     * Immutable from the outside - only `pushStage` creates a new array.
     * @private
     */

    private stages: Stage<any>[] = [];

    /**
     * @param instance - The `Redis` instance or `Chainable Commander` using `Redis.pipeline()` or `Redis.multi()`.
     * @param config - Optional aggregator-level configuration.
     */

    constructor(private instance: Redis, private config?: AggregatorConfig) { }


    // Private Helpers


    /**
     * Throws with the abort reason if `signal` is already aborted.
     * Called at the top of every stage loop iteration so the pipeline stops promptly when the caller cancels.
     *
     * @private
     */

    private throwOnAbort = (signal: AbortSignal | undefined) => {
        if (signal && signal.aborted) {
            throw signal.reason || new Error("Aggregation is aborted.")
        }
    }

    /**
     * Creates a new `RedisAggregator` instance with `stage` appended to the stages array and the current store snapshot shallow-copied.
     *
     * Returning a new instance (rather than mutating `this`) is what makes the chain safe to fork and share across call sites.
     *
     * @private
     */

    private pushStage<T>(stage: Stage<T>) {

        // Returning a new Aggregator to memory leaks.
        const next = new RedisAggregator(
            this.instance,
            this.config
        );

        next.stages = [...this.stages, stage];

        // Shallow copy is fine here - the store is empty at chain-build time.
        // structuredClone would deep-clone on every pushStage call, which is wasteful when the data is never populated until execution.
        next.store = new Store({ ...this.store.data });

        // Returning instance for chaining.
        return next;
    }

    /**
     * Races `promise` against a timeout and an optional `AbortSignal`.
     *
     * - If `timeout` seconds elapse first -> rejects with a timeout error.
     * - If `signal` fires first -> rejects with the abort reason (or a generic error).
     * - Otherwise -> resolves or rejects with the original promise's outcome.
     *
     * Cleanup (clearing the timer, removing the abort listener) always runs after the race settles to avoid memory leaks or spurious rejections.
     *
     * @private
     */

    private withTimeout = <T>(promise: Promise<T>, timeout: number | undefined, signal?: AbortSignal) =>
        new Promise<T>((resolve, reject) => {

            let settled = false;

            const correctTimeout = (timeout || timeout === 0) && Number.isFinite(timeout) && timeout > 0 ? timeout : 10;

            /** Clears the timer and removes the abort listener. */
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };

            /**
             * Settles the promise once - subsequent calls are no-ops.
             * Runs cleanup before invoking `fn` so listeners are removed before any error propagates.
             */
            const finish = (fn: () => void) => {
                cleanup();
                if (settled) return;
                settled = true;
                fn();
            };

            // Throws an error if timeout is reached before the promise is settled.
            const timer = setTimeout(() => {
                finish(() => reject(
                    new Error(`Redis Aggregator timeout exceeded ${correctTimeout}s.`)
                ));
            }, correctTimeout * 1000);

            // Stops the timeout if process is aborted.
            const onAbort = () => {
                finish(() => reject(
                    signal?.reason || new Error("Aggregation aborted.")
                ));
            };

            signal?.addEventListener("abort", onAbort);

            promise
                .then(val => finish(() => resolve(val)))
                .catch(err => finish(() => reject(err)));
        });


    // Core Engine


    /**
     * The inner aggregation loop.
     * Iterates the stages array, dispatching each stage to its handler.
     * Redis/JSON stages are accumulated in `stack` and flushed to Redis atomically on each `commit`.
     *
     * This method is called by both the public `.aggregate()` / `.aggregateSafe()` (which pass a fresh `Store`) and `.windup()` (which passes `this.store`).
     *
     * @private
     */

    private async performAggregation<T>(context: Context): Promise<T> {

        const { stages, store, signal } = context;

        // Validate structural rules eagerly - throw before touching Redis.
        validateStages(stages);

        // Accumulates redis/json stages between commits.
        let stack: ExtendedRedisStage[] = [];
        let returnVal: T | null = null;


        logForDebug(!!this.config?.debug, "About to start aggregation.");

        for (let i = 0; i < stages.length; i++) {
            const stage = stages[i];

            // Check for cancellation before every stage so we stop promptly.
            this.throwOnAbort(signal ?? this.config?.signal);

            logForDebug(!!this.config?.debug, "Got", stage.method, "at", i);

            // Simply push the stage in the stack if a redis or redis json stage is found.
            if (isRedisStage(stage) || isRedisJsonStage(stage)) {
                stack.push(stage);
            }

            else if (stage.method === "validate") {
                await validationStage(stage, store, i);
            }

            else if (stage.method === "derive") {
                await deriveStage(stage, store, i, !!this.config?.debug);
            }

            else if (stage.method === "branch") {
                const stages = await branchStage(stage, store, i);
                stack.push(...stages);
            }

            else if (stage.method === "transform") {
                await transformStage(stage, store, i);
            }

            else if (stage.method === "commit") {

                if (!stack.length && stage.allowEmptyBatch) continue;
                else if (!stack.length)
                    throw new Error(`Unexpected Commit stage at index ${i}! There must be at least one redis or redis-json stage between two Commit stages.`)

                // Executes the stack using pipeline.
                const results = await executeStack(this.instance, stack, this.config || {});

                // Maps the result returned by the pipeline to respective keys.
                mapResults(stack, results, store, !!this.config?.preserveArrayIndices);

                // Empty stack for upcoming stages.
                stack = [];
            }

            else if (stage.method === "windup") {
                returnVal = await stage.value(store.readonly());
                break;
            }

            // Should not be reachable if validateStages passed, but guards against runtime stage objects that bypassed the type system.
            else throw new Error(`Unexpected Stage at index ${i}. Got: ${JSON.stringify(stage)}`);
        }

        return returnVal as T;
    };


    // Public APIs - Execution


    /**
     * Executes the aggregation pipeline and returns the value produced by the `windup` stage.
     *
     * Use this method when you want exceptions to propagate naturally (i.e. you are wrapping the call in your own `try/catch`).
     * For a version that never throws, use `.aggregateSafe()`.
     *
     * @param stages - The complete stages array.
     * @param config - Per-call options 
     *               - `config.signal` for abort control.
     * 
     * @returns The value returned by `windup`.
     *
     * @throws {Error} On any structural rule violation, Redis error, validation failure, or timeout.
     *
     * @rules
     * - First stage must be `redis_*` or `json_*`.
     * - Every `redis_*`, `json_*`, or `branch` stage must be followed by `commit` stage.
     * - Last stage must be `windup` stage. Exactly one `windup` is allowed.
     *
     * @example
     * const user = await aggregator.aggregate<User>([
     *   { method: 'redis_get', key: `user:${id}`, ref: 'user' },
     *   { method: 'commit' },
     *   { method: 'windup', value: store => store.get('user') },
     * ]);
     */

    async aggregate<T>(stages: [ExtendedRedisStage, ...Stage<T>[], WindupStage], config?: { signal?: AbortSignal }): Promise<T> {
        try {
            return await this.withTimeout<T>(
                this.performAggregation({
                    stages,
                    store: new Store(),
                    signal: config?.signal,
                }),
                this.config?.timeoutInSeconds,
                config?.signal
            );
        } catch (e: any) {
            if (typeof e?.message === "string") {
                throw new Error(
                    `Redis Aggregation Error: ${e.message}`,
                    { cause: e }
                );
            }

            throw e;
        }
    }

    /**
     * A non-throwing version of `.aggregate()`.
     *
     * Returns a discriminated union so callers can handle errors without a `try/catch`.
     *
     * @param stages - The complete stages array.
     * @param config - Per-call options 
     *               - `config.signal` for abort control.
     * 
     * @returns The value returned by `windup`.
     *
     * @rules 
     * - First stage must be `redis_*` or `json_*`.
     * - Every `redis_*`, `json_*`, or `branch` stage must be followed by `commit` stage.
     * - Last stage must be `windup` stage. Exactly one `windup` is allowed.
     */

    async aggregateSafe<T>(stages: [ExtendedRedisStage, ...Stage<T>[], WindupStage], config?: { signal?: AbortSignal }): Promise<GeneralReturnType<T>> {
        try {
            const result = await this.withTimeout<T>(
                this.performAggregation({
                    stages,
                    store: new Store(),
                    signal: config?.signal,
                }),
                this.config?.timeoutInSeconds,
                config?.signal
            );

            return { success: true, result }
        } catch (e: any) {
            return {
                success: false,
                error: e
            }
        }
    }


    // Public APIs - Execution


    /**
     * Declares one or more Redis or RedisJSON commands to run against your Redis instance.
     * The commands are not sent to Redis here - they are collected and sent together as a single batch when `.commit()` is called.
     *
     * The key to find the results in the store would be `key` unless `ref` is passed then `ref` will become the key.
     * The results would not be filled in the store until the next `.commit()` stage.
     * Each and every key (or ref) should be unique.
     *
     * Only `redis_*` and `json_*` stages are accepted. For computed values use `.derive()`, for assertions use `.validate()`, and so on.
     *
     * @param stagesToPush - A single stage or an array of stages.
     * @returns RedisAggregator instance for chaining.
     *
     * @throws {Error} If any provided stage is not a redis or redis-json stage.
     *
     * @example
     * // Queue two commands together so they are sent to Redis in one round-trip:
     * aggregator
     *   .push({ method: 'redis_get',     key: 'user:1',    ref: 'user'    })
     *   .push({ method: 'redis_hgetall', key: 'profile:1', ref: 'profile' })
     *   .commit()
     * // After .commit(), store contains: { user: ..., profile: { ... } }
     *
     * @example
     * // You can also push an array to queue multiple commands in one call:
     * aggregator
     *   .push([
     *     { method: 'redis_get',  key: 'user:1',  ref: 'user'  },
     *     { method: 'redis_get',  key: 'user:2',  ref: 'user2' },
     *   ])
     *   .commit()
     */

    push(stagesToPush: ExtendedRedisStage | ExtendedRedisStage[]) {
        let current: RedisAggregator = this;
        (Array.isArray(stagesToPush) ? stagesToPush : [stagesToPush]).forEach(stage => {
            if (isRedisStage(stage) || isRedisJsonStage(stage)) {
                current = current.pushStage(stage);
            }
            else throw new Error(`Expected a Redis or Redis Json stage in .push but got: ${(stage as Stage<any>).method}`);
        });
        return current;
    }

    /**
     * Checks a condition against the current store state.
     * If the condition is `false`, the pipeline stops immediately and throws - no further stages run and nothing is returned.
     *
     * Use this as a guard after a `.commit()` to assert that the data you fetched is usable before continuing.
     * Common cases: checking a fetched value is not `null`, verifying a user has the required role, or confirming a record exists.
     *
     * The predicate receives the full read-only store.
     * If you only need one specific value, pass its store key as `ref` and it will be forwarded as the second argument - keeping the predicate focused and easy to test.
     *
     * @param validator - Returns `true` to continue or `false` to abort. Receives the read-only store and, if `ref` is provided, the value at that key as a second argument.
     * @param ref - Store key whose value is passed directly to the predicate as the second argument.
     * @param messageOnFailure - The error message thrown when the predicate returns `false`. Shown as-is to the caller - make it actionable.
     *
     * @throws {Error} With `messageOnFailure` (or a generic fallback) when the predicate returns `false`.
     *
     * @example
     * // Abort if the user doesn't exist:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   .commit()
     *   // store: { user: null }  <- key existed but Redis returned null
     *   .validate((store, user) => user !== null, 'user', 'User not found')
     *   // pipeline stops here and throws "Validation failed: User not found"
     *
     * @example
     * // Read multiple values from the store when one ref isn't enough:
     * aggregator
     *   .commit()
     *   .validate(store => {
     *     const user  = store.get<User>('user');
     *     const roles = store.get<string[]>('roles');
     *     return user.active && roles.includes('admin');
     *   }, undefined, 'User is inactive or lacks admin role')
     */

    validate(validator: ValidationStage["validate"], ref?: string, messageOnFailure?: string) {
        return this.pushStage({ method: "validate", ref, validate: validator, messageOnFailure });
    }

    /**
      * Computes one or more new values from the current store and makes them available to all subsequent stages under the keys you specify.
      *
      * Use this to produce values that aren't stored directly in Redis - for example, combining two fetched fields into one, parsing a raw string, computing a display label, or building a key for the next `.push()`.
      *
      * @param vals - Returns one `{ key, value }` pair or an array of pairs. Each pair is written to the store under its `key`.
      * @param ref - Store key whose current value is passed as the second argument to `vals`.
      *
      * @throws {Error} If any returned pair has an empty or falsy `key`.
      * @throws {Error} If any returned `key` already exists in the store.
      *
      * @example
      * // Produce a single derived value:
      * aggregator
      *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
      *   .commit()
      *   // store: { user: { firstName: 'Alice', lastName: 'Smith' } }
      *   .derive((store, user) => ({ key: 'fullName', value: `${user.firstName} ${user.lastName}` }), 'user')
      *   // store: { user: { ... }, fullName: 'Alice Smith' }
      *
      * @example
      * // Produce multiple derived values in one call:
      * aggregator
      *   .commit()
      *   .derive((store, user) => [
      *     { key: 'fullName',  value: `${user.firstName} ${user.lastName}` },
      *     { key: 'nextKey',   value: `session:${user.id}` },
      *   ], 'user')
      *   // store: { user: { ... }, fullName: 'Alice Smith', nextKey: 'session:42' }
      *   .push({ method: 'redis_get', key: store => store.get('nextKey'), ref: 'session' })
      */

    derive(vals: DeriveStage["vals"], ref?: string) {
        return this.pushStage({ ref, vals, method: "derive" });
    }

    /**
     * Transforms the value stored at a given key by passing it through a callback and saving whatever the callback returns back under the same key.
     *
     * Use this to clean up or reshape a value in place - trimming whitespace, parsing a raw string, converting units, renaming nested fields - without introducing a new key into the store.
     *
     * If you need to produce a value under a *new* key, use `.derive()` instead.
     * If you need to rewrite *several* keys at once, chain multiple `.transform()` calls.
     *
     * @param key - The store key to read, transform, and overwrite.
     * @param transform - Receives the current value at `key` and returns the new value that replaces it.
     *
     * @throws {Error} If `key` is empty or falsy.
     *
     * @example
     * // Normalise a raw string value that came back from Redis:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1:name', ref: 'userName' })
     *   .commit()
     *   // store: { userName: '  alice smith  ' }
     *   .transform('userName', (name) => name.trim().replace(/\b\w/g, c => c.toUpperCase()))
     *   // store: { userName: 'Alice Smith' }
     *
     * @example
     * // Parse a JSON string stored as a plain Redis string:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1:settings', ref: 'settings' })
     *   .commit()
     *   // store: { settings: '{"theme":"dark","lang":"en"}' }
     *   .transform('settings', (raw) => JSON.parse(raw as string))
     *   // store: { settings: { theme: 'dark', lang: 'en' } }
     */

    transform(key: string, transformer: TransformStage["transform"]) {
        return this.pushStage({ method: "transform", transform: transformer, key });
    }

    /**
     * Looks up for additional data in Redis, based on data already in the store.
     *
     * Use this when the data from one `.commit()` determines what you need to fetch next.
     * A common pattern: fetch a list of IDs, then fetch the full record for each ID.
     * Without `.branch()` you would need to end the pipeline and start a second one once you have the IDs - `.branch()` lets you do it in a single pipeline.
     *
     * The callback receives the current read-only store and returns an array of `redis_*` / `json_*` stages.
     * Those commands are added to the current batch and executed on the next `.commit()`, exactly as if you had called `.push()` with them directly.
     *
     * Because the commands are only known at runtime, `.explain()` cannot list them statically - it will show a warning in place of the injected stages.
     *
     * @param explore - Receives the read-only store and (if `ref` is provided, the value at that key) and returns the `redis_*` / `json_*` stages to run next.
     * @param ref - Store key whose current value is passed as the second argument to `explore`.
     *
     * @throws {Error} If `explore` returns too many stages.
     * @throws {Error} If any returned stage has an invalid or duplicate store key.
     * @throws {Error} If any returned stage is not a `redis_*` or `json_*` stage.
     *
     * @example
     * // Fetch a user's friend list, then fetch every friend's profile:
     * aggregator
     *   .push({ method: 'redis_smembers', key: 'user:1:friends', ref: 'friendIds' })
     *   .commit()
     *   // store: { friendIds: ['2', '3', '5'] }
     *   .branch(
     *     (store, ids) => ids.map(id => ({ method: 'redis_get', key: `user:${id}`, ref: `friend:${id}` })),
     *     'friendIds'
     *   )
     *   .commit()
     *   // store: { friendIds: [...], 'friend:2': { ... }, 'friend:3': { ... }, 'friend:5': { ... } }
     */

    branch(explore: BranchStage["explore"], ref?: string) {
        return this.pushStage({ method: "branch", explore, ref });
    }

    /**
     * Sends all commands declared since the last `.commit()` (or the start of the chain) to Redis in a single round-trip, then makes their results available to every stage that follows.
     * 
     * @throws {Error} If called with no `.push()` commands preceding it, or immediately after another `.commit()` with nothing in between.
     *
     * @example
     * // Without .commit() the store is empty - 'user' is not readable yet:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   // store: {}  <- 'user' doesn't exist here yet
     *   .validate((store) => store.has('user')) // always false - too early
     *
     * // With .commit() the result is available for all subsequent stages:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   .commit()
     *   // store: { user: { id: 1, name: 'Alice' } }  <- now readable
     *   .validate((store) => store.has('user')) // true
     *   .derive('greeting', store => `Hello, ${store.get<User>('user').name}`)
     *
     * @example
     * // Two separate commits - two round-trips, each result available after its commit:
     * aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   .commit()
     *   // store: { user: { id: 1, roles: ['admin'] } }
     *   .push({ method: 'redis_smembers', key: 'permissions:admin', ref: 'permissions' })
     *   .commit()
     *   // store: { user: { ... }, permissions: ['read', 'write'] }
     */

    commit(allowEmptyBatch?: boolean) {
        return this.pushStage({ method: "commit", allowEmptyBatch });
    }

    /**
     * Reads from the final store state and returns whatever value your callback produces - that value becomes the resolved result of the entire aggregator.
     *
     * This is the last call in every fluent chain. Once `.windup()` is called the pipeline executes immediately.
     * All `.push()` commands run, all `.commit()` round-trips fire, all intermediate stages are processed in order, and the Promise resolves when everything is done.
     * Nothing can be chained after `.windup()`.
     *
     * The callback receives the complete, final aggregator store. Pick out whatever keys you need - combine them, reshape them, or return one value directly.
     *
     * @param callback - Receives the final read-only store and returns the pipeline result. May be async.
     *
     * @throws {Error} On any structural rule violation, Redis error, validation failure, or timeout.
     *
     * @example
     * // Return a single fetched value:
     * const user = await aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   .commit()
     *   .validate((store, user) => user !== null, 'user', 'User not found')
     *   .windup(store => store.get<User>('user'));
     *
     * @example
     * // Assemble the result from multiple store keys:
     * const profile = await aggregator
     *   .push({ method: 'redis_get',     key: 'user:1',    ref: 'user'    })
     *   .push({ method: 'redis_smembers', key: 'user:1:roles', ref: 'roles' })
     *   .commit()
     *   .windup(store => ({
     *     ...store.get<User>('user'),
     *     roles: store.get<string[]>('roles'),
     *   }));
     */

    async windup<T>(callback: (store: AggregatorStore) => T | Promise<T>) {

        // Push stage in Stages Stack to perform aggregation.
        const next = this.pushStage({
            method: "windup",
            value: callback
        });

        // Perform Aggregation with timeout. If timeout is reached or operation is aborted, this would throw an error.
        return await next.withTimeout(
            next.performAggregation({
                stages: next.stages,
                store: next.store,
                signal: this.config?.signal
            }),
            Number(this.config?.timeoutInSeconds) || 10,
            this.config?.signal
        )
    }


    // Public API - Inspection

    /**
     * Returns a static analysis of the current pipeline **without executing anything against Redis** - analogous to MongoDB's `cursor.explain()`.
     *
     * Call this at any point in the chain to inspect what has been built so far.
     * Calling it before `.windup()` is added will report `valid: false` (since the pipeline isn't structurally complete yet), but the `entries` array will still describe the stages that have been declared.
     *
     * **What explain shows:**
     * - Every stage in declaration order, annotated with a human-readable description.
     * - Redis/JSON stages grouped into `ExplainedBatch` entries (one per `commit`).
     * - Warnings for patterns that limit static analysis (e.g. `branch` stages).
     * - `totalBatches` (= number of Redis round-trips) and `totalCommands`.
     * - A plain-English `summary` string suitable for logging.
     *
     * **What explain does NOT show:**
     * - Commands injected at runtime by `branch` stages (unknown until execution).
     * - The actual values returned by Redis (nothing is executed).
     *
     * @returns An `ExplainResult` describing the current pipeline.
     *
     * @example
     * const plan = aggregator
     *   .push({ method: 'redis_get', key: 'user:1', ref: 'user' })
     *   .commit()
     *   .derive('name', store => store.get<User>('user').name)
     *   .explain(); // <- call in the place of .windup() chain to inspect the plan.
     * 
     * or call it like this:
     * 
     * const plan = aggregator.explain([
     *  { method: 'redis_get', key: 'user:1', ref: 'user' },
     *  { method: 'commit' },
     *  { method: 'derive', key: 'name', vals: store => store.get<User>('user').name },
     *  { method: 'windup', value: (store) => { ... } }, // <- Make sure to add windup stage when you are passing stages like this.
     * ])
     *
     * console.log(plan.summary);
     * // Pipeline has 3 stage(s) across 1 Redis pipeline batch(es)
     * // executing 1 command(s). Each batch costs exactly 1 Redis round-trip...
     *
     * for (const entry of plan.entries) {
     *   if (entry.kind === 'batch') {
     *     console.log(`Batch ${entry.batch.batchIndex}:`, entry.batch.commands);
     *   } else {
     *     console.log(`[${entry.stage.index}] ${entry.stage.method}: ${entry.stage.description}`);
     *   }
     * }
     */

    explain<T>(stages?: Stage<T>[]): ExplainResult {
        const isChaining = !(stages && stages.length)
        return explainStages(isChaining ? this.stages : stages, isChaining);
    }

}