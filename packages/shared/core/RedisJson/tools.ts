
/**
 * Returns `true` if `v` is a non-empty string or a safe integer.
 *
 * Used to validate each element of a `$path` array before building Redis JSON path strings.
 *
 * @internal
 */

import { FieldPath, JSONArray, JSONObject, JSONValue, PathIndex, PathTraverse, Segment, UntypedPathObject } from "~/shared/types";
import { MAX_ARRAY_INDEX, MAX_DEPTH_FOR_RECORD } from "~/shared/lib/constants";
import { isObject, validateKey } from "~/shared/lib/utils";

const isValidSegment = (v: unknown): boolean =>
    (typeof v === "string" && v.length > 0) ||
    (typeof v === "number" && Number.isInteger(v));


/**
* Converts a `$index` specifier into one or more Redis JSON path strings of the form `"key[N]"`.
*
* @param index - A single non-negative integer, or an array of them.
* @param key - The parent field key to prepend (already resolved to dot-notation).
* @param allowNegativeIndex - If negative indexing should be allowed or not.
* @returns Array of path strings, one per index.
*
* @throws {Error} If any index is not an integer.
*
* @example
* ```ts
* handleIndexing(1, "tags")         // -> ["tags[1]"]
* handleIndexing([0, 2], "scores")  // -> ["scores[0]", "scores[2]"]
* ```
*
* @internal
*/

export const handleIndexing = (index: PathIndex["$index"], key: string, allowNegativeIndex: boolean): string[] => {

    if (Array.isArray(index)) {
        return index.flatMap(i => handleIndexing(i, key, allowNegativeIndex));
    }

    else if (Number.isInteger(index) && (allowNegativeIndex || index >= 0))
        return [`${key}[${index}]`];

    else throw new Error(`Only valid indexes are allowed. Expected number or array of number, for "${key}"`);
}


/**
 * Converts a `$path` array of segments into a Redis JSON dot-notation path suffix (e.g. `["user", "name"]` -> `".user.name"`).
 *
 * ### Segment rules
 * - String segments that match `[a-zA-Z0-9_-]+` become `.key`.
 * - Numeric segments become `[N]`.
 * - Nested arrays of segments produce multiple path suffixes (one per sub-path).
 *
 * @param path - Array of path segments, or array-of-arrays for multi-path.
 * @param key - The field key to show in error message.
 * @param allowNegativeIndex - If negative indexing should be allowed or not.
 * @returns A single path suffix string, or an array of them for multi-path input.
 *
 * @throws {Error} If the depth limit is reached or a segment has an invalid type.
 *
 * @internal
 */

export const handleTraversing = (path: PathTraverse["$path"], key: string, allowNegativeIndex: boolean): string | string[] => {

    if (path.length >= MAX_DEPTH_FOR_RECORD)
        throw new Error(`Maximum depth reached for key "${key}". Please use string based path instead.`);

    // Should throw error on null, undefined, empty string, false, NaN, etc. Because they are not valid key segments.
    if (!path.every(p =>
        Array.isArray(p)
            ? p.every(isValidSegment)
            : isValidSegment(p)
    )) {
        throw new Error(`Invalid segment in $path for key "${key}"`);
    }

    // Array-of-arrays: produce one path suffix per sub-array.
    else if (path.every(Array.isArray)) {
        return path.flatMap(p => handleTraversing(p, key, allowNegativeIndex));
    }

    // Flat array of segments: build a single path suffix.
    else {
        return path.map(p => {
            if (typeof p === "string" && /^[a-zA-Z0-9_-]+$/.test(p)) return `.${p}`
            else if (typeof p === "number" && (allowNegativeIndex || p >= 0)) return `[${p}]`
            else throw new Error(`Unexpected Type in $path. Expected string or number, got: ${typeof p}`)
        }).join('');
    }
}

// Type Guards for Path Object

const isPathIndex = (doc: unknown): doc is PathIndex => {
    return (isObject(doc) && "$index" in doc)
}

const isPathTraverse = (doc: unknown): doc is PathTraverse => {
    return (isObject(doc) && "$path" in doc)
}

/**
 * Resolves a `FieldPath` into an array of Redis JSON path strings for use in **read** commands (`JSON.GET`, `JSON.TYPE`, etc.).
 *
 * Supported input forms:
 * - `"$"` or any raw Redis JSON path string -> returned as-is.
 * - `string[]` -> each string returned as-is.
 * - `{ field: true }` -> `[".field"]`
 * - `{ tags: { $index: 2 } }` -> `[".tags[2]"]`
 * - `{ user: { name: { $path: ["first"] } } }` -> `[".user.name.first"]`
 * - Nested objects -> recursively flattened.
 *
 * @param path - The field path specifier.
 * @param count - Internal recursion depth counter; omit when calling externally.
 * @returns Array of Redis JSON path strings.
 *
 * @throws {Error} If a path array contains non-string elements.
 * @throws {Error} If the path type is unrecognised.
 *
 * @internal
 */

export const resolvePath = (path: FieldPath, count = 0): string[] => {
    if (count >= MAX_DEPTH_FOR_RECORD) throw new Error("Maximum depth reach for path, use string based path instead.");

    if (typeof path === "string") return [path];

    else if (Array.isArray(path)) {
        if (!path.every(p => typeof p === "string")) {
            throw new Error(`Path arrays must contain only strings, got: [${path.join(', ')}]`);
        }
        return path;
    }

    else if (isObject(path)) {
        return Object.entries(path).flatMap(([key, value]) => {

            if (value === true) return key;
            else if (value === undefined) return [];

            else if (isPathIndex(value)) return handleIndexing(value.$index, key, false);

            else if (isPathTraverse(value)) {
                const traversed = handleTraversing(value.$path, key, false);

                if (Array.isArray(traversed)) {
                    return traversed.map(p => `${key}${p}`)
                } else return key.concat(traversed);
            }

            else {
                const subObjResolvedPath = resolvePath(value as UntypedPathObject, count + 1);
                return subObjResolvedPath.map(field => `${key}.${field}`);
            }
        });
    }

    else throw new Error(`Invalid Path! Expected either string, array of string or PathObject type but got: ${typeof path}`)
}


// Redis response -> nested JS object transformation


/**
 * Parses a Redis JSON dot-notation path string into an ordered array of `Segment`s (string keys and numeric indices).
 *
 * Handles paths like `"user.address[0].street"` -> `["user", "address", 0, "street"]`.
 *
 * @param key - A Redis JSON path string as returned by `JSON.GET` with multiple path arguments.
 * @returns Ordered array of segments representing the nesting structure.
 *
 * @throws {Error} If the path syntax is invalid (unbalanced brackets, NaN index, index exceeding `MAX_ARRAY_INDEX`, forbidden key names).
 *
 * @internal
 */

export const parseKey = (key: string): Segment[] => {
    const result: Segment[] = [];

    const parts = key.split(".");

    for (const part of parts) {

        const matches = part.match(/([^\[\]]+)|\[(\d+)\]/g);

        if (!matches) {
            throw new Error(`Invalid key syntax: ${key}`);
        }

        for (const token of matches) {

            if (token.startsWith("[")) {

                const index = Number(token.slice(1, -1));

                if (!Number.isInteger(index) || index < 0) {
                    throw new Error(`Invalid array index in key: ${key}`);
                }

                if (index > MAX_ARRAY_INDEX) {
                    throw new Error(`Array index too large in key: ${key}`);
                }

                result.push(index);

            } else {

                validateKey(token);

                result.push(token);
            }
        }
    }

    return result;
};

/**
 * Writes `value` into `root` at the location described by `path`, creating intermediate objects and arrays as needed.
 *
 * Sibling segments are used to infer whether the next container should be an array (when the next segment is a number) or an object (when it is a string).
 * A type conflict (e.g. an existing object where an array is expected) throws rather than silently overwriting.
 *
 * @param root - Root `JSONObject` or `JSONArray` to write into (mutated in place).
 * @param path - Ordered segments produced by `parseKey`.
 * @param value - The value to assign at the leaf position.
 *
 * @throws {Error} On container type mismatches or traversal into non-objects/arrays.
 *
 * @internal
 */

export const setDeep = (
    root: JSONObject | JSONArray,
    path: Segment[],
    value: JSONValue
) => {

    let pointer: JSONObject | JSONArray = root;

    for (let i = 0; i < path.length; i++) {

        const seg = path[i];
        const next = path[i + 1];
        const isLast = i === path.length - 1;

        if (isLast) {

            if (typeof seg === "number") {

                if (!Array.isArray(pointer)) {
                    throw new Error(
                        `Expected array at segment '${seg}'`
                    );
                }

                pointer[seg] = value;

            } else {

                if (!isObject(pointer)) {
                    throw new Error(`Expected object at segment '${seg}'`);
                }

                pointer[seg] = value;
            }

            return;
        }

        const shouldBeArray = typeof next === "number";

        if (typeof seg === "number") {

            // current pointer MUST be array
            if (!Array.isArray(pointer)) {
                throw new Error(
                    `Expected array at segment '${seg}'`
                );
            }

            // create child if missing
            if (pointer[seg] === undefined) {
                pointer[seg] = shouldBeArray ? [] : {};
            }

            const child = pointer[seg];

            // validate existing child type
            if (
                shouldBeArray &&
                !Array.isArray(child)
            ) {
                throw new Error(
                    `Conflict: expected array at '${seg}'`
                );
            }

            if (
                !shouldBeArray &&
                !isObject(child)
            ) {
                throw new Error(
                    `Conflict: expected object at '${seg}'`
                );
            }

            pointer = child as JSONObject | JSONArray;

        } else {

            // current pointer MUST be object
            if (!isObject(pointer)) {
                throw new Error(
                    `Expected object at segment '${seg}'`
                );
            }

            // create child if missing
            if (pointer[seg] === undefined) {
                pointer[seg] = shouldBeArray ? [] : {};
            }

            const child = pointer[seg];

            // validate existing child type
            if (
                shouldBeArray &&
                !Array.isArray(child)
            ) {
                throw new Error(
                    `Conflict: expected array at '${seg}'`
                );
            }

            if (
                !shouldBeArray &&
                !isObject(child)
            ) {
                throw new Error(
                    `Conflict: expected object at '${seg}'`
                );
            }

            pointer = child as JSONObject | JSONArray;
        }
    }
};

/**
 * Recursively compacts sparse arrays and deeply-nested objects by removing `undefined` slots.
 *
 * Redis JSON path indices may leave gaps when some requested paths do not exist.
 * This function collapses those gaps so callers receive dense arrays rather than sparse ones with `undefined` holes.
 *
 * Arrays are filtered (order-preserving, gaps removed).
 * Objects are recursively normalised.
 * Primitives and `null` are returned as-is.
 *
 * @param obj - Value to normalise.
 * @returns Normalised value with `undefined` slots removed.
 *
 * @internal
 */

export const normalizeArrays = (obj: unknown): unknown => {

    if (Array.isArray(obj)) {
        const result = [];

        for (const item of obj) {
            const compacted = normalizeArrays(item);

            if (compacted !== undefined) {
                result.push(compacted);
            }
        }

        return result;
    }


    else if (isObject<JSONObject>(obj)) {
        const out: JSONObject = {}
        for (const [key, value] of Object.entries(obj)) {
            out[key] = normalizeArrays(value) as JSONObject;
        }
        return out;
    }

    return obj;
};

/**
 * Reconstructs a nested JavaScript object or array from the flat `{ "field.sub[0]": value }` map that Redis returns for multi-path `JSON.GET` calls.
 *
 * The root type (object vs array) is inferred from the first key's leading segment.
 * All subsequent keys must be consistent with the inferred root type;
 * a mismatch throws immediately.
 *
 * @param input - Flat key-to-value record from a Redis response.
 * @param preserveArrayIndices - When `true`, sparse arrays are kept as-is (index alignment is preserved).
 *                               When `false`, `normalizeArrays` compacts them into dense arrays.
 * @returns The reconstructed nested `JSONObject` or `JSONArray`.
 *
 * @throws {Error} On root-type conflicts or invalid path syntax in keys.
 *
 * @example
 * ```ts
 * transformRedisResponse(
 *   { "name": "Alice", "scores[0]": 10, "scores[1]": 20 },
 *   false
 * );
 * // -> { name: "Alice", scores: [10, 20] }
 * ```
 *
 * @internal
 */

export const transformRedisResponse = (input: JSONObject, preserveArrayIndices: boolean): JSONObject | JSONArray => {

    const entries = Object.entries(input);

    if (entries.length === 0) {
        return {};
    }

    // infer root type from first key
    const firstPath = parseKey(entries[0][0]);

    const root: JSONObject | JSONArray =
        typeof firstPath[0] === "number"
            ? []
            : {};

    for (const [key, value] of entries) {

        const path = parseKey(key);

        // enforce same root type
        if (
            typeof path[0] === "number" &&
            !Array.isArray(root)
        ) {
            throw new Error(
                `Root type conflict: expected object root`
            );
        }

        if (
            typeof path[0] === "string" &&
            Array.isArray(root)
        ) {
            throw new Error(
                `Root type conflict: expected array root`
            );
        }

        setDeep(root, path, value);
    }

    return preserveArrayIndices ? root : normalizeArrays(root) as JSONObject | JSONArray;
};
