/**
 * @file tools.ts
 * @description Path resolution, Redis response transformation, and Lua mutation stack builders.
 *
 * This module is the bridge between the high-level TypeScript API surface (field path objects, typed method signatures)
 * and the low-level Redis JSON wire format (dot-notation path strings, flat ARGV arrays for Lua).
 *
 * ### Key responsibilities
 * 1. **Path resolution** - `resolvePath` and `resolvePathForMutation` convert typed `FieldPath` objects into Redis JSON path strings
 *    (e.g. `{ user: { name: true } }` -> `[".user.name"]`).
 * 
 * 2. **Mutation stack building** - `resolvedPathToLuaMutationStack` and `resolvedPatchPathToLuaMutationStack` turn resolved path maps into ordered `LuaMutation[]` arrays ready for `mutateAtomically`.
 * 
 * 3. **Response transformation** - `transformRedisResponse` reconstructs a nested JavaScript object/array from the flat `{ "field.sub[0]": value }` map that Redis returns for multi-path `JSON.GET` calls.
 *
 * All exports are `@internal` unless noted.
 */


import { MAX_DEPTH_FOR_RECORD } from "~/shared/lib/constants";
import { handleIndexing, handleTraversing } from "~/shared/core/RedisJson";
import { isObject, mergeObjects, validateKey } from "~/shared/lib/utils";
import { AnyRecord, UnknownRecord } from "~/shared/types";
import { RedisJsonMutationCommands } from "./types";
import { LuaMutation } from "./types/lua";
import { PathIndexForMutation, PathTraverseForMutation, UnTypedPatchMethodPath } from "./types/overload";

export * from "~/shared/core/RedisJson/tools";

// Type Guards for Path Object

const isPathIndex = (doc: unknown): doc is PathIndexForMutation => {
    return (isObject(doc) && "$index" in doc)
}

const isPathTraverse = (doc: unknown): doc is PathTraverseForMutation => {
    return (isObject(doc) && "$path" in doc)
}

/**
 * Resolves a mutation path specifier into a flat `{ resolvedPath: value }` record.
 * Where each key is a Redis JSON dot-notation path and the value is whatever should be applied at that path.
 *
 * This is the core path-building utility for all mutator methods (`update`, `del`, `toggle`, `strAppend`, `numIncrBy`, etc.).
 *
 * @param path - Path specifier (string, string[], or nested object).
 * @param parentKey - Accumulated dot-notation prefix from parent recursion.
 * @param count - Internal recursion depth counter.
 * @returns Flat record mapping resolved path strings to their mutation values.
 *
 * @internal
 */

export const resolvePathForMutation = (path: UnknownRecord | string | string[], parentKey?: string, count = 0): UnknownRecord => {
    if (count >= MAX_DEPTH_FOR_RECORD) throw Error("Maximum Depth Reached!");

    if (typeof path === "string") return { [path]: true };

    let resolvedPath = Object.create(null) as UnknownRecord;

    if (Array.isArray(path)) {
        path.forEach(p => {
            validateKey(p);
            resolvedPath[p] = true;
        });
        return resolvedPath;
    }

    for (const key of Object.keys(path)) {
        const value = path[key];

        const keyForPath = parentKey ? `${parentKey}.${key}` : key;

        if (value === undefined || value === null) continue;

        else if (isObject(value)) {

            if (isPathIndex(value)) {
                const indexKeys = handleIndexing(value.$index, keyForPath, true);

                indexKeys.forEach(k => {
                    validateKey(k);
                    resolvedPath[k] = value.$value;
                });

            }

            else if (isPathTraverse(value)) {
                const traversed = handleTraversing(value.$path, key, true);

                if (Array.isArray(traversed)) {
                    traversed.forEach(p => {
                        const segment = `${keyForPath}${p}`;
                        validateKey(segment);
                        resolvedPath[segment] = value.$value;

                    });
                }
                else {
                    const segment = keyForPath.concat(traversed);
                    validateKey(segment);
                    resolvedPath[segment] = value.$value;
                }
            }

            else {
                const subObjResolvedPath = resolvePathForMutation(value, keyForPath, count + 1);

                for (const [k, v] of Object.entries(subObjResolvedPath)) {
                    validateKey(k);
                    resolvedPath[k] = v;
                }
            }
        }

        else {
            // Leaf value (string, number, boolean, array, true for del/toggle…).
            validateKey(keyForPath);
            resolvedPath[keyForPath] = value;
        }
    }

    return resolvedPath;
}

/**
 * Resolves a `patch()` method path object into the internal `UnTypedPatchMethodPath` structure.
 *
 * Patch paths are structured differently from plain mutation paths.
 * They carry an operation discriminator (`$set`, `$toggle`, `$array`, `$number`, etc.) at each level, which this function preserves while resolving the field paths they point to.
 *
 * @param path - Raw patch path object from the caller.
 * @param parent - Current `$array` or `$number` context (internal).
 * @returns Resolved patch path structure.
 *
 * @internal
 */

export const resolvePathForPatchMutation = (path: UnknownRecord, parent?: "$array" | "$number"): UnknownRecord => {

    let finalResolvedPath = Object.create(null) as UnTypedPatchMethodPath;

    if (parent) {
        // Inside a $array or $number context: resolve each sub-key's path and merge it under the parent discriminator.
        Object.entries(path).map(([key, value]) => {
            const resolvedPath = resolvePathForMutation(value as UnknownRecord);
            const parentObj = finalResolvedPath[parent];
            if (parentObj !== undefined)
                mergeObjects(parentObj, { [key]: resolvedPath });
            else
                mergeObjects(finalResolvedPath, { [parent]: { [key]: resolvedPath } });
        });
    }

    else {
        Object.entries(path).map(([key, value]) => {
            if (key === "$array" || key === "$number") {
                const resolvedPath = resolvePathForPatchMutation(value as UnknownRecord, key);
                mergeObjects(finalResolvedPath, resolvedPath);
            } else {
                if (key === "$merge") {
                    mergeObjects(finalResolvedPath, { $merge: value });
                } else {
                    const resolvedPath = resolvePathForMutation(value as UnknownRecord);
                    mergeObjects(finalResolvedPath, { [key]: resolvedPath });
                }
            }
        });
    }


    return finalResolvedPath;
}

/**
 * Extracts the array field path and insertion index from a resolved path key of the form `"fieldName[N]"`.
 *
 * This is used by `resolvedPathToLuaMutationStack` when building `arrinsert` or `arrPop` Lua mutations.
 * Where the target index is encoded directly in the path key rather than passed as a separate argument.
 *
 * @param k - A resolved path key ending with `[N]`, e.g. `"tags[0]"` or `"user.hobbies.indoor[2]"`.
 * @param op - Redis JSON operation in which this is used.
 * @param required - Controls if index is required or optional.
 * @returns `{ path, index }` - the field path without the bracket suffix, and the parsed integer index.
 *
 * @throws {Error} If required is true and `k` does not end with a valid `[N]` bracket expression.
 *
 * @example
 * ```ts
 * findIndexForArrInsert("tags[2]", "arrInsert", true)  // -> { path: "tags", index: 2 }
 * findIndexForArrInsert("user.hobbies", "arrPop", false)  // -> { path: "user.hobbies" }
 * ```
 *
 * @internal
 */

export const takeLastIndexFromKey = <R extends boolean>(k: string, op: string, required: R): { path: string, index: R extends true ? number : number | undefined } => {
    const matched = k.match(/^(.*)\[(\d+)\]$/);
    if (!matched) {
        if (required)
            throw new Error(`Index must be provided in "${op}" operation.`);
        else return { path: k, index: undefined as R extends true ? number : number | undefined }
    }
    const segments = Array.from(matched);
    const index = parseInt(segments[segments.length - 1]);

    if (Number.isNaN(index)) {
        throw new Error(`Index must be provided in "${op}" operation. Got: ${k}`);
    }

    const path = segments[segments.length - 2];

    return { path, index }

}


// Lua mutation stack builders

/**
 * Converts a resolved path map into an ordered `LuaMutation[]` stack for the given `command`.
 *
 * This is the final step before `mutateAtomically`.
 * It maps the `{ "field.sub": value }` flat record produced by `resolvePathForMutation` into the strongly-typed `LuaMutation` discriminated union.
 *
 * When `resolvedPath` is `undefined` the operation targets the document root (`"$"`), which is valid for `del` (delete whole document).
 *
 * @param resolvedPath - Flat path-to-value record, or `undefined` for root ops.
 * @param command - The RedisJSON mutation command to build mutations for.
 * @returns Ordered array of `LuaMutation` objects ready for `mutateAtomically`.
 *
 * @throws {Error} For unknown or invalid `command` values.
 *
 * @internal
 */

export const resolvedPathToLuaMutationStack = (resolvedPath: AnyRecord | undefined, command: RedisJsonMutationCommands): LuaMutation[] => {

    if (resolvedPath === undefined) return [{
        op: command.toLowerCase(),
        path: "$"
    } as LuaMutation]

    switch (command) {
        case "arrInsert": {
            return Object.entries(resolvedPath).map(([k, v]) => {
                const { index, path } = takeLastIndexFromKey(k, "arrInsert", true);
                return {
                    op: "arrinsert",
                    path: `.${path}`,
                    index,
                    values: Array.isArray(v) ? v : [v]
                }
            });
        }

        case "arrTrim": {
            return Object.entries(resolvedPath).map(([k, v]) => ({
                op: "arrtrim",
                path: `.${k}`,
                start: v[0],
                stop: v[1],
            }));
        }

        case "patch": {
            // Delegate to the patch-specific builder.
            return resolvedPatchPathToLuaMutationStack(resolvedPath)
        }

        case "set": {
            // `set` is meant to always targets the root and replaces the whole document.
            return [{
                op: "set",
                path: "$",
                value: resolvedPath
            }]
        }

        case "merge": {
            // `merge` is always meant targets the root; sub-path merges are not exposed through the public API.
            return [{
                op: "merge",
                path: "$",
                value: resolvedPath
            }]
        }

        case "update": {
            // `update` maps each resolved key to a targeted `set` at that path.
            return Object.entries(resolvedPath).map(([k, v]) => ({
                op: "set",
                path: `.${k}`,
                value: v
            } as LuaMutation));
        }

        case "arrAppend":
            {
                return Object.entries(resolvedPath).map(([k, v]) => ({
                    op: command.toLowerCase(),
                    path: `.${k}`,
                    values: Array.isArray(v) ? v : [v]
                } as LuaMutation));
            }

        case "numIncrBy":
        case "numMultBy":
        case "strAppend":
            {
                return Object.entries(resolvedPath).map(([k, v]) => ({
                    op: command.toLowerCase(),
                    path: `.${k}`,
                    value: v
                } as LuaMutation));
            }

        case "del":
        case "toggle":
        case "arrPop":
            {
                return Object.keys(resolvedPath).map(k => ({
                    op: command.toLowerCase(),
                    path: `.${k}`,
                } as LuaMutation));
            }

        default: {
            throw new Error(`Invalid Command! Expected a RedisJson Command, got: ${command}`)
        }
    }
}

/**
 * Converts a resolved **patch** path object into a `LuaMutation[]` stack.
 *
 * Delegates to `resolvedPathToLuaMutationStack` for the leaf-level commands and recursively handles the `$array` / `$number` sub-trees.
 *
 * @param patchPath - Output of `resolvePathForPatchMutation`.
 * @param parent - Current `$array` or `$number` context (internal).
 * @returns Ordered array of `LuaMutation` objects.
 *
 * @throws {Error} For unknown patch command keys.
 *
 * @internal
 */

export const resolvedPatchPathToLuaMutationStack = <T extends AnyRecord>(patchPath: T, parent?: "$array" | "$number"): LuaMutation[] => {

    if (parent === "$array") {
        return Object.entries(patchPath).flatMap(([key, value]) => {
            switch (key) {
                case "$append": {
                    return resolvedPathToLuaMutationStack(value, "arrAppend");
                }
                case "$insert": {
                    return resolvedPathToLuaMutationStack(value, "arrInsert");
                }
                case "$trim": {
                    return resolvedPathToLuaMutationStack(value, "arrTrim");
                }
                case "$pop": {
                    return resolvedPathToLuaMutationStack(value, "arrPop");
                }
                default: {
                    throw new Error(`Invalid Method in '$array' while performing patch! Expected a RedisJson Array Command, got: ${key}`)
                }
            }
        });
    }

    else if (parent === "$number") {
        return Object.entries(patchPath).flatMap(([key, value]) => {
            switch (key) {
                case "$inc_by": {
                    return resolvedPathToLuaMutationStack(value, "numIncrBy");
                }
                case "$mul_by": {
                    return resolvedPathToLuaMutationStack(value, "numMultBy");
                }
                default: {
                    throw new Error(`Invalid Method in '$number' while performing patch! Expected a RedisJson Number Command, got: ${key}`)
                }
            }
        });
    }

    return Object.entries(patchPath).flatMap(([key, value]) => {

        switch (key as keyof UnTypedPatchMethodPath) {
            case "$appendInString": {
                return resolvedPathToLuaMutationStack(value, "strAppend");
            }
            case "$array": {
                return resolvedPatchPathToLuaMutationStack(value, "$array");
            }
            case "$set": {
                return resolvedPathToLuaMutationStack(value, "update");
            }
            case "$merge": {
                return resolvedPathToLuaMutationStack(value, "merge");
            }
            case "$toggle": {
                return resolvedPathToLuaMutationStack(value, "toggle");
            }
            case "$number": {
                return resolvedPatchPathToLuaMutationStack(value, "$number");
            }

            default: {
                throw new Error(`Invalid Operation in Patch Method! Got: ${key}`);
            }

        }
    });

}