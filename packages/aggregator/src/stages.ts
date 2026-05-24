/**
 * @file stages.ts
 *
 * Individual stage handlers invoked by the aggregation engine.
 *
 * Each handler is a pure async function that accepts the resolved stage object, the current aggregation store, the stage index (for error context), and any additional config flags.
 * 
 * They mutate the store in place and return nothing, except for `branchStage`, which returns the dynamically resolved list of redis/json stages to inject into the active pipeline stack.
 * 
 * Keeping these as standalone functions (rather than methods on the engine) makes them independently unit-testable without constructing a full `RedisAggregator`.
 */

import { logForDebug } from "~/shared/lib/utils";
import { BranchStage, DeriveStage, ExtendedRedisStage, Stage, TransformStage, TypedStore, ValidationStage } from "./types/aggregator";
import { isRedisJsonStage, isRedisStage } from "./tools";

/**
 * Executes a `validate` stage.
 *
 * Calls the user-supplied `stage.validate` predicate with a read-only view of the store (and optionally a pinned value from `stage.ref`).
 * Throws if the predicate returns `false` or a rejected Promise.
 *
 * @param stage - The validation stage configuration.
 * @param store - The mutable aggregation store (passed as readonly to the callback).
 * @param i - Zero-based stage index - included in error messages for context.
 *
 * @throws {Error} When `stage.validate` returns `false`. The message comes from `stage.messageOnFailure` if provided, otherwise a generic fallback.
 *
 * @example
 * // In a pipeline:
 * { 
 *      method: 'validate',
 *      ref: 'user',
 *      validate: (store, user) => user !== null,
 *      messageOnFailure: 'User not found'
 * }
 */

export const validationStage = async (stage: ValidationStage, store: TypedStore, i: number) => {
    const condition = await stage.validate(
        store.readonly(),
        stage.ref ? store.get(stage.ref) : undefined
    );

    if (!condition) {
        const message = stage.messageOnFailure ?? `Validation failed at stage ${i}.`
        throw new Error(`Validation failed: ${message}`);
    }
}

/**
 * Executes a `branch` stage and returns the dynamically resolved list of Extended Redis stages to inject into the active stack.
 *
 * The user-supplied `stage.explore` callback receives a read-only store (and optionally a pinned value from `stage.ref`) and returns an array of `redis_*` / `json_*` stages.
 * These are appended to the pipeline stack and executed in the next `commit`.
 *
 * **Why this is separate from the engine loop:**
 * The engine calls this function, takes the returned stages, and pushes them into the current `stack` array.
 * This keeps the engine loop clean and makes branch resolution independently testable.
 *
 * @param stage - The branch stage configuration.
 * @param store - The mutable aggregation store (passed as readonly to the callback).
 * @param i - Zero-based stage index - included in error messages.
 * @returns An array of `ExtendedRedisStage` objects to inject.
 *
 * @throws {Error} If the callback returns 100 or more stages (safety cap to prevent accidental pipeline explosions).
 * @throws {Error} If any returned stage has an empty or falsy `storeAs`/`key`.
 * @throws {Error} If any returned stage's `storeAs`/`key` already exists in the store (duplicate key detection).
 * @throws {Error} If any returned stage is not a redis or redis-json stage.
 *
 * @example
 * // Dynamically fetch each friend's profile based on an ID list:
 * {
 *      method: 'branch',
 *      ref: 'friendIds',
 *      explore: (store, ids) => ids.map(id => ({ 
 *          method: 'redis_get',
 *          key: `user:${id}`,
 *          storeAs: `friend:${id}` 
 *      }))
 * }
 */

export const branchStage = async (stage: BranchStage, store: TypedStore, i: number) => {

    const branchStages = await stage.explore(
        store.readonly(),
        stage.ref ? store.get(stage.ref) : undefined
    );

    // Safety cap: prevent accidental pipeline explosions from a misconfigured branch.
    if (branchStages.length >= 100)
        throw new Error(`Branch Stage limit exceeded! Got 99+ stages at index ${i}`);

    // To make sure every branched stages have unique key
    const keySet = new Set();

    // Validate each returned stage - only redis/json stages are allowed because
    // only those can be batched into a pipeline.
    const stages = branchStages.map((s, ind) => {

        if (!(isRedisStage(s) || isRedisJsonStage(s))) {
            throw new Error(
                `Branch stage at index ${i} returned an invalid stage at position ${ind}. ` +
                `Only redis or redis-json stages are allowed inside a branch. ` +
                `Got: "${(s as Stage<any>).method}".`
            )
        }

        const storeKey = s.storeAs || s.key;

        // Guard: key must be a non-empty string
        if (!storeKey) {
            throw new Error(`Invalid Key! Branch stage at index ${i} returned a stage with invalid key at position ${ind}. Expected a string, got ${storeKey}`)
        }

        // Skipping this stage as it is already in the batch.
        else if (keySet.has(s.key)) return null;

        // Guard: duplicate key
        else if (store.has(storeKey)) {
            throw new Error(
                `Duplicate store key detected! ` +
                `Branch stage at index ${i} returned a stage with duplicate key "${storeKey}" at position ${ind}.`
            );
        }

        keySet.add(s.key);
        return s;

    }).filter(Boolean) as ExtendedRedisStage[];

    return stages;
}

/**
 * Executes a `derive` stage.
 *
 * Calls the user-supplied `stage.vals` function with a read-only view of the store and (optionally) a pinned value from `stage.ref`.
 * The callback may return either a single `{ key, value }` pair or an array of pairs - both forms are normalised and each pair is written to the store.
 *
 * This makes `derive` suitable for computing one or several related values in a single stage (e.g. splitting a raw Redis hash into typed fields).
 *
 * **Store integrity:**
 * Both an empty/falsy `key` and a key that already exists in the store are treated as hard errors.
 * Duplicate keys are almost always a misconfiguration and silent overwrites would produce subtle, hard-to-trace bugs.
 *
 * @param stage - The derive stage configuration.
 *   - `stage.vals` - Callback returning one `{ key, value }` pair or an array of pairs.
 *   - `stage.ref` - Optional store key whose value is passed as the second argument to `vals`.
 * @param store - The mutable aggregation store.
 * @param i - Zero-based stage index - included in error messages.
 * @param allowDebug - When `true`, logs each newly derived key/value pair.
 *
 * @throws {Error} If any returned pair has an empty or falsy `key`.
 * @throws {Error} If any returned `key` already exists in the store (duplicate key detection).
 *
 * @example
 * // Single derived value:
 * {
 *     method: 'derive',
 *     ref: 'user',
 *     vals: (store, user) => ({ key: 'fullName', value: `${user.first} ${user.last}` })
 * }
 *
 * @example
 * // Multiple derived values in one stage:
 * {
 *     method: 'derive',
 *     ref: 'user',
 *     vals: (store, user) => [
 *         { key: 'fullName', value: `${user.first} ${user.last}` },
 *         { key: 'initials', value: `${user.first[0]}${user.last[0]}` },
 *     ]
 * }
 */

export const deriveStage = async (stage: DeriveStage, store: TypedStore, i: number, allowDebug: boolean) => {

    const { vals, ref } = stage;

    const values = await vals(
        store.readonly(),
        ref ? store.get(ref) : undefined
    );

    Object.entries(values).forEach(([key, value], ind) => {

        // Guard: key must be a non-empty string.
        if (!key)
            throw new Error(
                `Invalid Key! Derive stage at index ${i} returned a stage with invalid key at position ${ind}. Required string, got: ${JSON.stringify(key)}.`
            );

        // Guard: duplicate key - silent overwrite is almost always a bug.
        else if (store.has(key)) {
            throw new Error(
                `Duplicate store key detected! ` +
                `Derive stage at index ${i} returned a stage with duplicate key "${key}" at position ${ind}.`
            );
        }

        store.set(key, value);
        logForDebug(allowDebug, `[derive] Added key { ${key}: ${JSON.stringify(value)} }`);
    });

}

/**
 * Executes a `transform` stage.
 *
 * Fetches the value currently stored at `stage.key`, passes it to the user-supplied `stage.transform` callback, and writes the returned value back to the store **under the same key** - i.e. an in-place transformation.
 *
 * Use this when you want to reshape or normalise a value that was previously written to the store (by a `commit`, `derive`, or another `transform`) without introducing a new key.
 *
 * **How `transform` differs from `derive`:**
 * 
 * | Concern        | `derive`                               | `transform`                       |
 * |----------------|----------------------------------------|-----------------------------------|
 * | Keys written   | One or more new keys                   | Exactly one - the same key        |
 * | Input          | Full store + optional `ref` shorthand  | The current value at `stage.key`  |
 * | Typical use    | Computing and naming new values        | Reshaping an existing stored value|
 *
 * @param stage - The transform stage configuration.
 *              - `stage.key` - The store key whose value is read and overwritten.
 *              - `stage.transform` - Callback that receives the current value and returns the new value.
 * @param store - The mutable aggregation store.
 * @param i - Zero-based stage index - included in error messages.
 *
 * @throws {Error} If `stage.key` is empty or falsy - the store cannot be addressed without a valid key.
 *
 * @example
 * // Normalise a stored name to title-case:
 * {
 *     method: 'transform',
 *     key: 'userName',
 *     transform: (name) => name.trim().replace(/\b\w/g, c => c.toUpperCase())
 * }
 *
 * @example
 * // Parse a JSON string that Redis returned as a raw string:
 * {
 *     method: 'transform',
 *     key: 'settings',
 *     transform: (raw) => JSON.parse(raw as string)
 * }
 */

export const transformStage = async (stage: TransformStage, store: TypedStore, i: number) => {

    const { key, transform } = stage;

    // Make sure the key is a non-empty string
    if (!key)
        throw new Error(
            `Invalid key in Transform stage at index ${i}. Expected a non-empty string, got: ${key === '' ? '"" (empty string)' : JSON.stringify(key)}.`
        );

    // Make sure the key already exists
    else if (!store.has(key))
        throw new Error(
            `Invalid key in Transform stage at index ${i}. The key does not exists in the store to transform.`
        );

    const transformedVal = await transform(store.readonly(), store.get(key));

    store.set(key, transformedVal);
}