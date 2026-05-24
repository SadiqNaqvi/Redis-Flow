
import { resolvePath, transformRedisResponse } from "~/shared/core/RedisJson/tools";
import type {
    AccessorOverload,
    AccessorOverloadIncludeRoot,
    AnyRecord,
    FieldPath,
    JSONObject,
    NestedValueObject,
    RedisJsonAccessorReturn,
    RedisJsonConfig,
    StrictAccessorOverload,
    StrictAccessorOverloadIncludeRoot,
} from "~/shared/types";
import { RedisJsonAccessCommands, RedisJsonAccessorConfig } from "~/shared/types";
import { ChainableCommander, Redis } from "ioredis";
import { handlePipelineResponse, isObject, logForDebug, logTimeForDebug, parseUnknownData } from "~/shared/lib/utils";


export default class RedisJsonAccessor<R extends Redis | ChainableCommander> {

    /**
     * `true` when the provided instance is a `ChainableCommander` (pipeline).
     * Detected once at construction; drives the dual-mode dispatch throughout all methods.
     *
     * @internal
     */

    protected isPipelineInstance = false;

    /**
     * @param instance - A `Redis` instance for atomic mutations, or `redis.pipeline()` / another `ChainableCommander` for batched mode.
     * @param config - Optional library-level configuration.
     */

    constructor(protected instance: R, protected config?: RedisJsonConfig) {
        this.isPipelineInstance = !("pipeline" in instance && typeof instance.pipeline === "function");
    }

    // -------------------------------------------------------------------------
    // Private: core pipeline accessor
    // -------------------------------------------------------------------------

    /**
     * Executes one or more `JSON.<command>` read operations, collects results from the pipeline, and transforms them into a nested JS object.
     *
     * In pipeline mode (`isPipelineInstance === true`) the commands are queued and `this` is returned; the caller must invoke `.exec()` later to flush.
     *
     * @param command - RedisJSON access command (e.g. `"get"`, `"type"`).
     * @param key - Target document key.
     * @param path - Optional field path; defaults to the document root (`"$"`).
     * @param config - Accessor-level options.
     * @returns `Promise<T>` in standard mode; `this` in pipeline mode.
     *
     * @internal
     */

    private accessWithPipeline = <T extends AnyRecord>(command: RedisJsonAccessCommands, key: string, path: FieldPath | undefined, config: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, T> => {
        const paths = path ? resolvePath(path) : ["$"];
        const pipeline = this.isPipelineInstance ? this.instance : (this.instance as Redis).pipeline();

        logForDebug(!!this.config?.debug, "About to perform:", command, "on key:", key);
        logTimeForDebug(!!this.config?.debug && !this.isPipelineInstance, `${command} command for ${key} took`);

        paths.forEach(path => {
            pipeline.call(`json.${command}`.toUpperCase(), key, path);
        });

        if (this.isPipelineInstance) {

            // Pipeline mode: commands are queued. Caller flushes via .exec().
            return this as unknown as RedisJsonAccessorReturn<R, T>;

        } else {

            // Standard mode: execute the pipeline and transform the response.

            const result = pipeline.exec().then(r => {
                const result = handlePipelineResponse<T>(r, false, this.config?.pipelineResponseHandler);
                if (paths[0] === "$") {

                    // Root-path responses come back as [[{ ...doc }]]; unwrap.
                    if (Array.isArray(result[0])) {
                        return result[0][0];
                    }
                    return result[0];
                }

                // Multi-path: build a flat { path: value } record and transform it into a nested object.
                let flat = {} as AnyRecord;

                paths.forEach((path, ind) => {
                    flat[path] = result[ind]
                })

                const transformed = transformRedisResponse(flat, !!config?.preserveArrayIndices);
                return transformed;
            }) as RedisJsonAccessorReturn<R, T>;

            logForDebug(!!this.config?.debug, "Done performing:", command, "on key:", key);
            logTimeForDebug(!!this.config?.debug, `${command} command for ${key} took`, true);

            return result;
        }
    }

    // =========================================================================
    // Public read API
    // =========================================================================

    /**
     * Fetches the full JSON document stored at `key`.
     *
     * @param key - Key of the document.
     * @returns
     *   - Standard mode (default): `Promise<T>` resolving to the parsed document.
     *   - Pipeline mode: `this` (chain and call `.exec()` later).
     *
     * @example
     * ```ts
     * const user = await json.get<User>(key);
     * ```
     *
     * @see {@link pick} to retrieve only selected fields.
     */

    get<T extends Record<string, unknown>>(key: string) {
        return this.accessWithPipeline<T>("get", key, undefined, {});
    };

    /**
     * Fetches one or more specific fields from a JSON document.
     *
     * More efficient than `get` when the document is large.
     *
     * @param key - Key of the document.
     * @param path - Field path specifier (string, string[], or path object).
     * @param option - Optional accessor configuration.
     * @returns
     *   - Standard mode (default): `Promise` resolving to a partial document shaped by `path`.
     *   - Pipeline mode: `this`.
     *
     * @example
     * ```ts
     * const partial = await json.pick(key, { name: true, email: true });
     * // -> { name: "Alice", email: "alice@example.com" }
     * ```
     *
     * @see {@link get} to retrieve the full document.
     */

    pick: AccessorOverload<R, unknown> = (key: string, path: FieldPath, option?: RedisJsonAccessorConfig) => {

        // `pick` uses a direct JSON.GET call with multiple path arguments rather than a pipeline,
        // giving Redis a chance to serialise only the requested fields in a single pass.

        if ("pipeline" in this.instance && typeof this.instance.pipeline === "function") {

            logForDebug(!!this.config?.debug, "About to perform: pick on key:", key);
            logTimeForDebug(!!this.config?.debug && !this.isPipelineInstance, `pick command for ${key} took`);

            return this.instance
                .call("JSON.GET", key, ...resolvePath(path))
                .then(r => parseUnknownData(r))
                .then(r => {
                    let result;
                    if (isObject<JSONObject>(r))
                        result = transformRedisResponse(r, !!option?.preserveArrayIndices);
                    else {
                        result = transformRedisResponse({ [String(path)]: r }, !!option?.preserveArrayIndices)
                    }

                    logForDebug(!!this.config?.debug, "Done performing: pick on key:", key);
                    logTimeForDebug(!!this.config?.debug && !this.isPipelineInstance, `pick command for ${key} took`, true);

                    return result;
                }) as RedisJsonAccessorReturn<R, NestedValueObject<unknown>>;
        }

        // Pipeline mode: queue the call and return this for chaining.
        this.instance.call("JSON.GET", key, ...resolvePath(path));
        return this as unknown as RedisJsonAccessorReturn<R, NestedValueObject<unknown>>;
    };

    /**
     * Returns the RedisJSON type of one or more fields, or of the whole document.
     * 
     * Possible type strings: `"string"`, `"integer"`, `"number"`, `"boolean"`, `"object"`, `"array"`, `"null"`.
     * 
     * @param key - Key of the document.
     * @param path - Path of the field(s) of the document. Pass `undefined` if the whole document is meant.
     * @returns 
     * - Standard mode (default):
     * - `{ [field]: "string" | "integer" | … | null }` - `null` when a field does not exist.
     * - `null` when `key` does not exist.
     * 
     * - Pipeline mode: `this`.
     * 
     * @example 
     * 
     * ```ts
     * // doc: { name: "John", age: 25 }
     * 
     * await json.type(key, "name");
     * // -> { name: "string" }
     * await json.type(key, { name: true, age: true, location: true });
     * // -> { name: "string", age: "integer", location: null }
     * 
     * await json.type("wrong-key");
     * // -> null
     */

    type: AccessorOverloadIncludeRoot<R, string | null> = <T extends AnyRecord>(key: string, path: FieldPath | undefined, option?: RedisJsonAccessorConfig) => {
        return this.accessWithPipeline<T>("type", key, path, option || {});
    }

    /**
     * Returns the byte length of one or more string fields.
     * 
     * @param key - Key of the document.
     * @param path - Path to one or more string fields.
     * @returns 
     * - Standard mode (default): `{ [fieldName]: length }` where length is the number of characters in the string value.
     * - Pipeline mode: `this`.
     * 
     * @throws {Error} if any of the specified field is not string type.
     * 
     * @example 
     * ```ts
     * doc: { name: "John", age: 25 }
     * 
     * json.strLen(key, "name") // returns { name: 5 }
     * json.strLen(key, { name: true, age: true }) // `Error`
     * json.strLen(key, { name: true, location: true }) // `Error` since field does not exists.
     * ```
     * 
     * `Important` - If the key of the document is incorrect, the values would be `null`.
     * 
     * @example
     * ```ts
     * json.type(wrongKey, { name: true, age: true }); // returns { name: null, age: null }
     * ```
     */

    strLen: StrictAccessorOverload<R, string, number> = <T extends AnyRecord>(key: string, path: FieldPath, option?: RedisJsonAccessorConfig) => {
        return this.accessWithPipeline<T>("strLen", key, path, option || {});
    }

    /**
     * Returns the number of top-level keys in one or more object fields, or in the whole document.
     * 
     * @param key Key of the document
     * @param path Path to one or more object fields, or `undefined` for the root document.
     * @param option - Optional accessor configuration.
     * @returns 
     * - Standard mode (default): `{ [fieldName]: count }`, or a single `number` for the root.
     * - Pipeline mode: `this`.
     * 
     * @throws {Error} - If any targeted field is not an object.
     * 
     * @example 
     * ```ts
     * doc: { name: "John", location: {city: "...", state: "...", country: "..."} }
     * 
     * json.objLen(key, "location") // returns { location: 3 }
     * json.objLen(key, { location:true }) // returns { location: 3 }
     * json.objLen(key) // returns 2
     * json.objLen(key, { name: true, location: true }) // `Error`- name is not an object.
     * ```
     * 
     * `Important` - Returns `null` per field when the field or document does not exist.
     * 
     * @example
     * ```ts
     * json.type(key, { location: true, age: true }); // returns { location: 3, age: null }
     * json.type(wrongKey); // returns null
     * json.type(wrongKey, { location: true }); // returns { location: null }
     * ```
     * 
     */

    objLen: StrictAccessorOverloadIncludeRoot<R, AnyRecord, number | null> = <T extends AnyRecord>(key: string, path: FieldPath | undefined, option?: RedisJsonAccessorConfig) => {
        return this.accessWithPipeline<T>("objLen", key, path, option || {});
    }

    /**
     * Returns the top-level key names of one or more object fields, or of the whole document.
     *
     * @param key - Key of the document.
     * @param path - Path to one or more object fields, or `undefined` for root.
     * @param option - Optional accessor configuration.
     * @returns 
     * - Standard mode (default): `{ [fieldName]: string[] }` mapping each field to its key list.
     * - Pipeline mode: `this`.
     *
     * @example
     * ```ts
     * // doc: { name: "Alice", age: 30 }
     * await json.objKeys(key); // returns ["name", "age"]
     * ```
     */

    objKeys: StrictAccessorOverloadIncludeRoot<R, AnyRecord, string[]> = <T extends AnyRecord>(key: string, path: FieldPath | undefined, option?: RedisJsonAccessorConfig) => {
        return this.accessWithPipeline<T>("objKeys", key, path, option || {});
    }


}