/**
 * @file engine.ts
 * @description The `RedisJson` class - the primary public API for this library.
 *
 * `RedisJson<R>` is a generic wrapper around a `Redis` instance (or a `ChainableCommander` pipeline).
 * It exposes typed read and write methods that compile down to atomic Lua mutations (via `mutateAtomically`) when given a regular `Redis` instance.
 * Or to queued pipeline commands when given a `ChainableCommander`.
 *
 * ### Dual-mode operation
 * The class detects at construction time whether `instance` is a standard `Redis` client or a `ChainableCommander` (e.g. `redis.pipeline()`):
 *
 * | Mode              | `instance` type       | Mutations           | Return value      |
 * |-------------------|-----------------------|---------------------|-------------------|
 * | **Standard**      | `Redis`               | Atomic via Lua      | `Promise<T>`      |
 * | **Pipeline**      | `ChainableCommander`  | Queued `.call()`s   | `this` (chainable)|
 *
 * In pipeline mode, call `.exec()` on the `RedisJson` instance at the end to flush the queue and receive results.
 *
 * @example Standard usage
 * ```ts
 * const json = new RedisJson(redis);
 * const user = await json.get<User>(key);
 * await json.update(key, { "status": "active" });
 * ```
 *
 * @example Pipeline usage
 * ```ts
 * const json = new RedisJson(redis.pipeline());
 * json.get("user:1").get("user:2");
 * const [user1, user2] = await json.exec();
 * ```
 */

import { ChainableCommander, Redis } from "ioredis";
import { handlePipelineResponse, isObject, logForDebug, logTimeForDebug, parseUnknownData } from "~/shared/lib/utils";
import { mutateAtomically } from "./atomicMutation";
import { takeLastIndexFromKey, resolvedPathToLuaMutationStack, resolvePath, resolvePathForMutation, resolvePathForPatchMutation, transformRedisResponse } from "./tools";
import type { JSONObject, RedisJsonAccessCommands, RedisJsonAccessorConfig, RedisJsonConfig, RedisJsonMutationCommands, RedisJsonMutatorConfig, RedisJsonReturn } from "./types/engine";
import type {
    AccessorOverload,
    AccessorOverloadIncludeRoot,
    AnyRecord,
    ArrAppendMethodOverload, ArrInsertMethodOverload, ArrPopMethodOverload, ArrTrimMethodOverload, DeleteMethodOverload,
    FieldPath, MergeMethodOverload, NestedValueObject,
    NumberMethodOverload, PatchMethodOverload,
    PathForArrAppend,
    SetMethodOverload, StrAppendMethodOverload,
    StrictAccessorOverload,
    StrictAccessorOverloadIncludeRoot,
    ToggleMethodOverload,
    TypedNormalPathObject,
    UntypedPathForArrInsert,
    UntypedPathForArrPop,
    UntypedPathForArrTrim,
    UntypedPathForNumberMethods,
    UntypedPathForStrAppend,
    UntypedPathForToggleMethod,
    UpdateMethodOverload
} from "./types/overload";
import { LuaAtomicMutationReturnMode } from "./types/lua";
import { RedisJsonAccessor } from "~/shared/core/RedisJson";


/**
 * Typed RedisJSON client that wraps a `Redis` instance or `ChainableCommander` pipeline.
 *
 * Instantiate with a regular `Redis` object for standard (atomic) mode, or with `redis.pipeline()` for pipeline (batched) mode.
 *
 * @typeParam R - Either `Redis` (standard mode) or `ChainableCommander` (pipeline mode).
 *            The return types of all methods are conditional on `R`.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * import { RedisJson } from "./engine";
 *
 * const redis = new Redis();
 * const json = new RedisJson(redis, { debug: false });
 * ```
 */

export class RedisJson<R extends Redis | ChainableCommander> extends RedisJsonAccessor<R> {

    /**
     * @param instance - A `Redis` instance for atomic mutations, or `redis.pipeline()` / another `ChainableCommander` for batched mode.
     * @param config - Optional library-level configuration.
     */

    constructor(instance: R, config?: RedisJsonConfig) {
        super(instance, config);
    }

    // -------------------------------------------------------------------------
    // Private: core pipeline mutator
    // -------------------------------------------------------------------------

    /**
     * Resolves `path` into a mutation stack and executes it either atomically (standard mode, via `mutateAtomically`) or by queuing individual `JSON.*` calls (pipeline mode).
     *
     * @param command - RedisJSON mutation command.
     * @param key - Target document key.
     * @param pathOrValue - Field path specifier, or the full document value for `set` and `merge`.
     * @param option - Mutator-level options (debug, return mode, etc.).
     * @param customValuesGenerator - Optional pipeline-mode override that builds the queued commands instead of the default logic.
     *                                Only called when `isChaining` is `true`.
     * @param storeAsItIs - When `true`, leaf values are stored as-is rather than being interpreted as "flag = true means delete/toggle this field".
     *                      Used by `update` to avoid misinterpreting boolean field values.
     * 
     * @returns `Promise<T>` in standard mode; `this` in pipeline mode.
     *
     * @internal
     */

    private mutateAtomically<T, V = unknown>(
        command: RedisJsonMutationCommands,
        key: string,
        pathOrValue: undefined | NestedValueObject<V> | string | string[],
        option: RedisJsonMutatorConfig,
        customValuesGenertor?: (pipeline: ChainableCommander, pathObj: Record<string, V>) => void,
        storeAsItIs?: boolean,
    ): RedisJsonReturn<R, T> {

        // Resolve the path specifier into a flat { "field.sub": value } record.
        let resolvedValue = {} as AnyRecord;

        if (isObject(pathOrValue) && (command === "set" || command === "merge")) {
            // set / merge take the whole document - no path resolution needed.
            resolvedValue = pathOrValue;
        } else if (isObject(pathOrValue) && command === "patch") {
            resolvedValue = resolvePathForPatchMutation(pathOrValue);
        } else if (pathOrValue) {
            resolvedValue = resolvePathForMutation(pathOrValue);
        }

        const allowDebug = !!option.debug;

        // ---- Pipeline (ChainableCommander) mode ----

        if (this.isPipelineInstance) {

            // Operate on root - no path argument.
            if (!pathOrValue) {
                this.instance.call(`json.${command}`.toUpperCase(), key, '$');
            } else if (command === "set" || command === "merge") {
                // Root set / merge - serialise the whole value.
                this.instance.call(
                    `json.${command}`.toUpperCase(),
                    key,
                    '$',
                    JSON.stringify(resolvedValue)
                );
            } else if (customValuesGenertor) {
                // Caller provides custom command-queuing logic.
                customValuesGenertor(this.instance as ChainableCommander, resolvedValue);
            } else {

                // Default per-field dispatch.
                Object.entries(resolvedValue).forEach(([p, value]) => {

                    logForDebug(allowDebug, "performing:", command, "on key:", key, "at path:", p, "with value:", value);

                    // The command name uses the real JSON.* name (update maps to JSON.SET).
                    const jsonCommand = `json.${command === "update" ? "set" : command}`.toUpperCase();

                    if (value === true && !storeAsItIs) {

                        // `true` is a sentinel for del / toggle (no value arg).
                        this.instance.call(jsonCommand, key, p);

                    } else if (Array.isArray(value) && !storeAsItIs) {

                        // Arrays are spread as individual arguments (e.g. ARRAPPEND).
                        this.instance.call(jsonCommand, key, p, ...value.map(entry => JSON.stringify(entry)));

                    } else {
                        this.instance.call(jsonCommand, key, p, JSON.stringify(value));
                    }
                });
            }

            return this as unknown as RedisJsonReturn<R, T>;

        }

        // ---- Standard (Redis) mode - atomic Lua execution ----

        const luaMutations = resolvedPathToLuaMutationStack(pathOrValue ? resolvedValue : undefined, command);

        const returnMode: LuaAtomicMutationReturnMode = option.returns
            ? option.returns === "mutated document"
                ? "mutated"
                : "nonMutated"
            : "none"

        return mutateAtomically(this.instance as Redis, key, luaMutations, returnMode)
            .then(result => {

                logForDebug(allowDebug, "Done performing:", command, "on key:", key);

                const parsed = parseUnknownData(result);

                if (Array.isArray(parsed)) {

                    // Root / set / merge operations return response like ["OK"] - unwrap.
                    if (!pathOrValue || command === "set" || command === "merge") return parsed[0];

                    // patch always succeeds or throws; normalise to "OK".
                    else if (command === "patch") {
                        return "OK";
                    }

                    const paths = Object.keys(resolvedValue);

                    if (paths.length === parsed.length) {

                        // Map each result to its corresponding resolved path key, then reconstruct a nested object.
                        let flat = {} as AnyRecord;

                        // ["OK", "OK"] -> { name: "OK", age: "OK" }

                        paths.forEach((path, ind) => {
                            flat[path] = parseUnknownData(parsed[ind]);
                        });

                        return transformRedisResponse(flat, !!option.preserveArrayIndices);

                    }

                    // Fallback: return the array with each element parsed.
                    else return parsed.map(parseUnknownData);
                } else return parsed;
            })
            .finally(() => {
                logTimeForDebug(allowDebug, `${command} command for ${key} took`, true);
            }) as RedisJsonReturn<R, T>;
    }

    // =========================================================================
    // Public write API
    // =========================================================================

    /**
     * Creates or replaces a JSON document at `key`.
     *
     * The entire document is serialised and stored atomically.
     * Any existing document at `key` is overwritten.
     *
     * @param key - Key to identify the document.
     * @param value - A plain JavaScript object representing the document.
     * @param option - Optional mutator configuration.
     * @returns
     * - Standard mode:
     * - `"OK"` on success (standard mode, default).
     * - The created document if `option.returns` is `"mutated document"`.
     * 
     * - Pipeline mode: `this`.
     * 
     * @example
     * ```ts
     * await json.set("user:1", { name: "Alice", age: 30 });
     * // -> "OK"
     * ```
     */

    set: SetMethodOverload<R> = <T extends AnyRecord>(key: string, value: T, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("set", key, value, option || {});
    }

    /**
     * Recursively dispatches a patch value object to the appropriate mutator method calls when running in pipeline mode.
     *
     * Each recognised key (`$set`, `$toggle`, `$array`, etc.) maps to a corresponding `RedisJson` method.
     * The pipeline queues each resulting `JSON.*` command without executing immediately.
     *
     * @param key - Target document key.
     * @param obj - Patch value object (same structure accepted by `patch`).
     *
     * @throws {Error} For unknown patch command keys.
     *
     * @internal
     */

    private performPatch = (key: string, obj: Record<string, any>) => {

        Object.entries(obj).forEach(([k, value]) => {
            switch (k) {
                case "$appendInString": {
                    this.strAppend(key, value);
                    break;
                }
                case "$set": {
                    this.update(key, value);
                    break;
                }
                case "$merge": {
                    this.merge(key, value);
                    break;
                }
                case "$toggle": {
                    this.toggle(key, value);
                    break;
                }
                case "$array":
                case "$number": {
                    this.performPatch(key, value);
                    break;
                }
                case "$append": {
                    this.arrAppend(key, value);
                    break;
                }
                case "$insert": {
                    this.arrInsert(key, value);
                    break;
                }
                case "$trim": {
                    this.arrTrim(key, value);
                    break;
                }
                case "$pop": {
                    this.arrPop(key, value);
                    break;
                }
                case "$inc_by": {
                    this.numIncrBy(key, value);
                    break;
                }
                case "$mul_by": {
                    this.numMultBy(key, value);
                    break;
                }
                default: {
                    throw new Error(`Unknown command in patch method! Got ${k}`);
                }
            }

        });

    }

    /**
     * Applies a structured patch to an existing JSON document.
     *
     * `patch` is the most expressive mutator - it bundles multiple field-level operations into a single atomic call.
     * Use it when you need to combine updates, toggles, string appends, numeric increments, and array operations in one round-trip.
     *
     * For simpler scenarios (updating several fields, deep-merging a sub-object) prefer `update` or `merge` which have lighter syntax.
     *
     * ### Patch operation keys
     * | Key                  | Effect                               |
     * |----------------------|--------------------------------------|
     * | `$set`               | Updates field values                 |
     * | `$merge`             | Deep-merge an object into a field    |
     * | `$toggle`            | Flip boolean fields                  |
     * | `$appendInString`    | Append to string fields              |
     * | `$array.$append`     | Append elements to array fields      |
     * | `$array.$insert`     | Insert elements into array fields    |
     * | `$array.$trim`       | Trim array fields to a range         |
     * | `$array.$pop`        | Pop element from array fields        |
     * | `$number.$inc_by`    | Increment numeric fields             |
     * | `$number.$mul_by`    | Multiply numeric fields              |
     *
     * 
     * @param key - Key of the document.
     * @param value - Patch operation descriptor.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `"OK"` on success (standard mode, default).
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @example
     * ```ts
     * await json.patch("user:1", {
     *   $set:    { "status": "active" },
     *   $toggle: { "emailVerified": true },
     *   $number: { $inc_by: { "loginCount": 1 } },
     *   $array:  { $append: { "tags": ["beta"] } },
     * });
     * ```
     */

    patch: PatchMethodOverload<R> = <T extends AnyRecord>(key: string, value: Record<string, unknown>, option?: RedisJsonMutatorConfig): RedisJsonReturn<R, T> => {
        if (!("pipeline" in this.instance && typeof this.instance.pipeline === "function")) {
            this.performPatch(key, value);
            return this as unknown as RedisJsonReturn<R, T>
        }
        return this.mutateAtomically<T>("patch", key, value, option || {});
    }

    /**
     * Updates (sets) one or more specified fields of an existing JSON document.
     *
     * Unlike `set`, this does not replace the whole document - only the fields referenced in `value` are written.
     * Fields not mentioned are untouched.
     *
     * @param key - Key of the document.
     * @param value - Path specifier where each leaf value is the new value to write at that path.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: "OK" }` per updated field (standard mode, default).
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @example
     * ```ts
     * // doc: { name: "Alice", age: 30, status: "inactive" }
     * await json.update("user:1", { status: "active", age: 31 });
     * // doc is now: { name: "Alice", age: 31, status: "active" }
     * ```
     */

    update: UpdateMethodOverload<R> = <T extends AnyRecord>(key: string, value: string | string[] | NestedValueObject<true>, option?: RedisJsonMutatorConfig): RedisJsonReturn<R, T> => {
        return this.mutateAtomically<T, true>(
            "update",
            key,
            value,
            option || {},
            undefined,
            true // storeAsItIs: don't interpret boolean values as del/toggle sentinels
        );
    }

    /**
     * Deep-merges a plain object into the root of an existing JSON document.
     *
     * Uses Redis's `JSON.MERGE` command: existing keys are overwritten with values from `value`, new keys are added.
     * Keys absent from `value` are left untouched.
     * To remove keys, combine `merge` with `del`.
     *
     * @param key - Key of the document.
     * @param value - Object to merge into the document root.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `"OK"` on success (standard mode, default).
     *   - The merged document if `option.returns` is `"mutated document"`.
     *   - The pre-merge document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @example
     * ```ts
     * // doc: { name: "Alice", role: "user" }
     * await json.merge("user:1", { role: "admin", verified: true });
     * // doc is now: { name: "Alice", role: "admin", verified: true }
     * ```
     */

    merge: MergeMethodOverload<R> = <T extends AnyRecord>(key: string, value: string | string[] | NestedValueObject<true>, option?: RedisJsonMutatorConfig): RedisJsonReturn<R, T> => {
        return this.mutateAtomically<T, true>("merge", key, value, option || {}, undefined, true);
    }

    /**
     * Deletes one or more fields from a JSON document, or the entire document.
     *
     * Passing `undefined` as `path` (or omitting it) deletes the whole document key from Redis.
     *
     * @param key - Key of the document.
     * @param path - Path specifier for the fields to delete, or `undefined` to delete the entire document.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{[fieldName]: 1 or 0 }` - 1 means deleted, 0 otherwise (standard mode, default).
     *   - The pre-deletion document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @example
     * ```ts
     * // doc: { name: "Alice", age: 30, tempToken: "abc" }
     * await json.del("user:1", { tempToken: true });
     * // doc is now: { name: "Alice", age: 30 }
     *
     * await json.del("user:1"); // deletes the key entirely
     * ```
     */

    del: DeleteMethodOverload<R> = <T extends AnyRecord>(key: string, value: undefined | Partial<TypedNormalPathObject<T, true>>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T, true>("del", key, value as NestedValueObject<true> | undefined, option || {});
    }

    /**
     * Appends a string to the end of one or more string fields.
     *
     * No whitespace is inserted automatically - include it in the value string if needed.
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to the string fragment to append.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newLength }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not string.
     * 
     * @example
     * ```ts
     * // doc: { name: "Alex" }
     * await json.strAppend("user:1", { name: " Costa" });
     * // doc is now: { name: "Alex Costa" }
     * ```
     */

    strAppend: StrAppendMethodOverload<R> = <T extends AnyRecord = never>(key: string, value: Partial<UntypedPathForStrAppend>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("strAppend", key, value, option || {});
    }

    /**
     * Increments one or more numeric fields by a specified amount.
     *
     * **Only works on `integer` or `number` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to the increment delta.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newValue }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not number.
     * 
     * @example
     * ```ts
     * // doc: { loginCount: 5 }
     * await json.numIncrBy("user:1", { loginCount: 1 });
     * // doc is now: { loginCount: 6 }
     * ```
     */

    numIncrBy: NumberMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForNumberMethods>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("numIncrBy", key, value, option || {});
    }

    /**
     * Multiplies one or more numeric fields by a specified factor.
     *
     * **Only works on `integer` or `number` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to the multiplication factor.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newValue }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not number.
     *
     * @example
     * ```ts
     * // doc: { price: 10.0 }
     * await json.numMultBy("item:1", { price: 1.2 }); // 20% markup
     * // doc is now: { price: 12.0 }
     * ```
     */

    numMultBy: NumberMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForNumberMethods>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("numMultBy", key, value, option || {});
    }

    /**
     * Appends one or more elements to the end of array fields.
     *
     * **Only works on `array` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to the element(s) to append.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newLength }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not array.
     *
     * @example
     * ```ts
     * // doc: { tags: ["typescript", "redis"] }
     * await json.arrAppend("post:1", { tags: ["json", "cache"] });
     * // doc is now: { tags: ["typescript", "redis", "json", "cache"] }
     * ```
     */

    arrAppend: ArrAppendMethodOverload<R> = <T extends AnyRecord>(key: string, value: PathForArrAppend<T>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("arrAppend", key, value, option || {});
    }

    /**
     * Inserts one or more elements into an array field at a specific index.
     *
     * **Only works on `array` type fields.**
     *
     * Elements are inserted *before* the element currently at `index`.
     * Negative indices count from the end: `-1` inserts before the last element (at last second).
     * To append at the very end use `arrAppend` instead.
     *
     * @param key - Key of the document.
     * @param value - Map of field paths (with `[N]` index suffix) to the element(s) to insert.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newLength }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not array.
     * 
     * @example
     * ```ts
     * // doc: { fav_games: ["GTA", "COD"] }
     * await json.arrInsert("user:1", { fav_games: { $index: 1, $value: "Fortnite" } });
     * // doc is now: { fav_games: ["GTA", "Fortnite", "COD"] }
     *
     * // Negative index: insert before last element
     * // doc: { fav_games: ["GTA", "Fortnite", "COD"] }
     * await json.arrInsert("user:1", { fav_games: { $index: -1, $value: "Angry Birds" } });
     * // doc is now: { fav_games: ["GTA", "Fortnite", "Angry Birds", "COD"] }
     * ```
     */

    arrInsert: ArrInsertMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForArrInsert>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("arrInsert", key, value, option || {}, (pipeline, pathObj) => {
            Object.keys(pathObj).forEach(k => {

                const { index, path } = takeLastIndexFromKey(k, "arrInsert", true);

                if (Number.isInteger(index)) {
                    pipeline.call("JSON.ARRINSERT", key, path, index, JSON.stringify(pathObj[k]));
                }
            })
        });
    }

    /**
     * Trims an array field to the sub-range `[start, stop]` (both inclusive).
     *
     * Elements outside this range are permanently removed. Elements *at* the boundary indices are **kept**.
     *
     * **Only works on `array` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to `[start, stop]` boundary tuples.
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: newLength }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not array.
     * 
     * @example
     * ```ts
     * // doc: { fav_games: ["GTA", "Fortnite", "COD"] }
     * await json.arrTrim("user:1", { fav_games: [1, 2] });
     * // doc is now: { fav_games: ["Fortnite", "COD"] }
     *
     * // Boundaries are inclusive - both boundary elements are kept:
     * await json.arrTrim("user:1", { fav_games: [0, 2] });
     * // doc remains: { fav_games: ["GTA", "Fortnite", "COD"] }  (length 3)
     *
     * // Trim to a single element:
     * await json.arrTrim("user:1", { fav_games: [0, 0] });
     * // doc is now: { fav_games: ["GTA"] }
     * ```
     */

    arrTrim: ArrTrimMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForArrTrim>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("arrTrim", key, value, option || {});
    }

    /**
     * Removes and returns the element at a specific index from an array field.
     *
     * When `index` is omitted the **last** element is popped (equivalent to `index = -1`).
     * To trim elements or to remove more than one element from the middle of an array, use `arrTrim` instead.
     *
     * **Only works on `array` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Map of field paths to `true` (pop last) or `{ $index: N, $value: true }` (pop at index N).
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: poppedElement }` per field on success.
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not array.
     * 
     * @example
     * ```ts
     * // doc: { fav_games: ["GTA", "Fortnite", "COD"] }
     * await json.arrPop("user:1", { fav_games: true });
     * // returns { fav_games: "COD" }
     * // (fav_games is now ["GTA", "Fortnite"])
     *
     * // Pop from a nested array:
     * // doc: { hobbies: { indoor: ["Reading", "Painting", "Chess"] } }
     * await json.arrPop("user:1", { hobbies: { indoor: true } });
     * // returns { hobbies: { indoor: "Chess" } }
     * // (indoor is now ["Reading", "Painting"])
    *
    * // Pop at a specific index (using $index):
    * // doc: { someField: [[1,2,3],[4,5,6]] }
    * await json.arrPop("user:1", { someField: { $index: 1, $value: true } });
    * // returns { someField: 6 }
     * // (someField is now [[1,2,3],[4,5]])
     * ```
     */

    arrPop: ArrPopMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForArrPop>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("arrPop", key, value, option || {});
    }

    /**
     * Flips one or more boolean fields (`true` -> `false`, `false` -> `true`).
     *
     * **Only works on `boolean` type fields.**
     *
     * @param key - Key of the document.
     * @param value - Path specifier where each leaf is `true` (meaning "toggle this field").
     * @param option - Optional mutator configuration.
     * @returns
     *   - `{ [field]: 0 | 1 }` per field (0 = now false, 1 = now true).
     *   - The mutated document if `option.returns` is `"mutated document"`.
     *   - The pre-mutation document if `option.returns` is `"non mutated document"`.
     *   - `this` in pipeline mode.
     *
     * @throws {Error} - If any of the targeted field is not boolean.
     *
     * @example
     * ```ts
     * // doc: { notifications: true, darkMode: false }
     * await json.toggle("user:1", { notifications: true, darkMode: true });
     * // doc is now: { notifications: false, darkMode: true }
     * ```
     */

    toggle: ToggleMethodOverload<R> = <T extends AnyRecord>(key: string, value: Partial<UntypedPathForToggleMethod>, option?: RedisJsonMutatorConfig) => {
        return this.mutateAtomically<T>("toggle", key, value, option || {});
    }

    /**
     * Executes all queued commands (pipeline mode only) and returns the parsed results.
     *
     * Call this after chaining multiple operations on a `RedisJson` instance that was initialised with a `ChainableCommander`.
     *
     * @returns Array of parsed results, one entry per queued command, in the order the commands were added.
     *
     * @throws {Error} If any queued command fails (non-graceful by default).
     *   Use a `try/catch` or pass a `config.pipelineResponseHandler` for
     *   custom error handling.
     *
     * @throws {Error} If the instance was initialised with Redis instead of `Chainable Commander`.
     *
     * @example
     * ```ts
     * const json = new RedisJson(redis.pipeline());
     * json.get("user:1").get("user:2").get("user:3");
     * const [u1, u2, u3] = await json.exec();
     * ```
     */

    async exec() {
        if (this.isPipelineInstance)
            return await this.instance
                .exec()
                .then((r) => handlePipelineResponse(r, false, this.config?.pipelineResponseHandler));
        else throw new Error("Passed instance at initialization must be Chainable Commander created using 'redis.pipeine()'")
    }
}