/**
 * @file utils.ts
 * @description Global utility functions shared across the Aggregator and RedisJSON modules.
 *
 * This module provides:
 * - Pipeline response parsing and error normalisation (`handlePipelineResponse`, `handlePipelineResponseGracefully`)
 * - Data deserialisation (`parseUnknownData`)
 * - Deep-object helpers (`mergeObjects`, `removeNullableFields`, `isObject`)
 * - Prototype-pollution guards (`validateKey`)
 * - Debug logging shims (`logForDebug`, `logTimeForDebug`)
 *
 * All exports marked `@internal` are implementation details not intended for direct use by library consumers.
 */

import { UnknownRecord } from "../types/index";
import { HandlePipelineResponseType, MustBeArray, PipelineHandlerInput, PipelineResponseHandlerFunction } from "../types";
import { FORBIDDEN_KEYS, MAX_DEPTH_FOR_RECORD } from "./constants";

/**
 * Attempts to parse `data` as JSON if it is a string; returns it unchanged for any other type.
 *
 * Redis stores everything as strings, so primitive values and serialised JSON objects/arrays both arrive as strings.
 * This function normalises them back to their JS types so callers don't need to hand-parse every result.
 *
 * **Edge-case handling:**
 * - A string that looks like a broken object/array (`{` or `[` prefix but fails `JSON.parse`) throws, rather than silently returning the raw string.
 *   This surfaces data-corruption issues early instead of propagating a malformed partial object into the store.
 * - Non-string values are returned as-is (they may already be parsed by the Redis client, e.g. RESP3 clients that auto-cast integers).
 *
 * @param data - Value from a Redis command response.
 * @returns The parsed value, or the original value if no parsing was needed.
 *
 * @throws {Error} If `data` looks like a JSON object/array but cannot be parsed.
 *
 * @internal
 */

export const parseUnknownData = (data: unknown) => {
    if (typeof data === "string") {
        const trimmed = data.trim();
        try {
            return JSON.parse(trimmed);
        } catch {
            // A string that starts with `{` or `[` was almost certainly meant to be JSON - failing silently here would be worse than throwing.
            if ((trimmed.startsWith("{") || trimmed.startsWith('['))) {
                throw new Error(`Unable to parse this data: ${data}`);
            }
        }
    }
    // Non-string or plain string (e.g. "hello") - return as-is.
    return data;
}

/**
 * Wraps any value in a single-element array if it is not already an array.
 *
 * Pipeline results are always normalised to arrays so `mapResults` can
 * uniformly iterate them alongside the stack, regardless of whether a command
 * returns a scalar or a list.
 *
 * @param input - Any value.
 * @returns The original array, or `[input]` for non-arrays.
 *
 * @internal
 */

export const returnArray = <T>(input: T): MustBeArray<T> => {
    if (Array.isArray(input)) return input as MustBeArray<T>;
    return [input] as MustBeArray<T>;
}

/**
 * Joins an array of errors (strings or `Error` objects) into a single
 * comma-separated error string. Used to surface all pipeline errors at once
 * rather than only the first one.
 *
 * @param arr - Mix of strings and Error objects from `handlePipelineResponseGracefully`.
 * @returns A single concatenated message, e.g. `"key not found, type mismatch"`.
 *
 * @internal
 */

export const handleMultipleErrors = (arr: (Error | string)[]) => {
    return arr.map(e => typeof e === "string" ? e : e.message).join(', ')
}

/**
 * Processes the raw result of `pipeline.exec()` into a normalised `{ success, result, errors }` envelope **without throwing**.
 *
 * ioredis (and most Redis clients) return pipeline results as `[error | null, value][]` tuples. This function:
 * - Unwraps each tuple
 * - Calls `parseUnknownData` on each value
 * - Flattens single-element arrays
 * - Collects per-command errors in `errors`
 *
 * **Prefer `handlePipelineResponse`** in most call sites. Use this function when you need the raw error list without throwing - e.g. for custom error reporting or retry logic.
 *
 * @param res - Raw `pipeline.exec()` result.
 * @returns `{ success, result, errors }` envelope.
 *
 * @internal
 */

export const handlePipelineResponseGracefully = <T,>(res: PipelineHandlerInput): HandlePipelineResponseType<MustBeArray<T>> => {

    try {
        // Guard: empty result
        if (!res || !res.length) {
            // if user does not want the error to be thrown.
            return { success: false, result: null, errors: ["Pipeline returned nothing."] }
        }

        // Edge case: client returned a non-array (should not happen with ioredis, but guard defensively).
        else if (!Array.isArray(res)) return {
            success: true,
            result: returnArray(res as T),
            errors: [],
        }

        const errors: string[] = [];
        const response = res.map(response => {

            // Some clients may return a plain value instead of a tuple for certain commands (e.g. custom pipeline handlers).
            if (!Array.isArray(response)) return response;

            const [e, r] = response; // [error, result]

            if (e) {
                errors.push(e instanceof Error ? e.message : e);

                // hold the array slot with `null` so the index alignment in `mapResults` is preserved.
                return null;
            }

            // result could be Primitive or Record or Array
            const parsed = parseUnknownData(r);

            // If result is an array, return result;
            if (Array.isArray(parsed)) {
                // Multi-element array: recursively parse each element (e.g. SMEMBERS may return JSON-encoded strings).
                return parsed.map(elem => parseUnknownData(elem));
            }

            // Otherwise return parsed Record
            return parsed as T;
        }); // (T | null)[]

        return {
            success: !errors.length,
            result: returnArray(response),
            errors,
        } as HandlePipelineResponseType<MustBeArray<T>>

    } catch (e: any) {
        return {
            success: false,
            result: null,
            errors: [e.message]
        }
    }
}

/**
 * Processes the raw result of `pipeline.exec()` and returns the parsed results array, **throwing** on any error unless `swallowPipelineErrors` is enabled.
 *
 * This is the throwing sibling of `handlePipelineResponseGracefully` and is the function called inside `executeStack` by default.
 *
 * @param res - Raw `pipeline.exec()` result.
 * @param swallowPipelineErrors - When `true`, errors are omitted from the result (their slots become `null`) rather than thrown. The corresponding store keys will receive `null` values - log a warning if this happens.
 * @returns The parsed results array.
 *
 * @throws {Error} On any pipeline command error when `swallowPipelineErrors` is `false`.
 *
 * @internal
 */

export const handlePipelineResponse = <T,>(res: PipelineHandlerInput, swallowPipelineErrors: boolean, customResponseHandler: PipelineResponseHandlerFunction | undefined): T[] => {

    // if user wants to handle the raw pipeline response themselves.
    // Responsibility for correctness (right length, right order) shifts to them.

    if (customResponseHandler) {
        return customResponseHandler(res) as T[];
    }

    const { errors, result } = handlePipelineResponseGracefully(res);

    if (errors.length && !swallowPipelineErrors) {
        throw new Error(handleMultipleErrors(errors))
    }

    return (result ? result : []) as MustBeArray<T>;
}

/**
 * Conditionally logs to `console.log` when `shouldLog` is `true`.
 *
 * Wraps all debug output so it can be stripped at a single flag rather than scattered `if (debug)` guards.
 *
 * @param shouldLog - Pass `config.debug` here.
 * @param messages - Values forwarded verbatim to `console.log`.
 *
 * @internal
 */

export const logForDebug = (shouldLog: boolean, ...messages: any[]) => {
    if (shouldLog)
        console.log(...messages);
}

/**
 * Conditionally starts or ends a `console.time` timer when `shouldLog` is `true`.
 *
 * @param shouldLog - Pass `config.debug` here.
 * @param label - Timer label passed to `console.time` / `console.timeEnd`.
 * @param end - When `true`, calls `console.timeEnd` otherwise `console.time`.
 *
 * @internal
 */

export const logTimeForDebug = (shouldLog: boolean, label?: string, end?: boolean) => {
    if (!shouldLog) return;
    else if (end) console.timeEnd(label);
    else console.time(label);
}

/**
 * Asserts that a key segment is not a prototype-pollution vector.
 *
 * Call this before any dynamic property write (e.g. inside `mergeObjects` or `resolvePathForMutation`).
 *
 * @param seg - String or numeric segment to validate.
 * @returns `true` when the segment is safe (enables use in boolean contexts).
 *
 * @throws {Error} If `seg` is one of the forbidden property names.
 *
 * @internal
 */

export const validateKey = (seg: string | number) => {
    if (typeof seg === "string" && FORBIDDEN_KEYS.has(seg)) {
        throw new Error(`Invalid Key Found! '${seg}' is not allowed as a key.`)
    }

    return true;
};

/**
 * Shallowly merges all own enumerable properties of `objToMerge` into `ogObj`, mutating `ogObj` in place.
 *
 * Each key is validated against `validateKey` before assignment to prevent prototype pollution.
 *
 * @param ogObj - Target object; **mutated** by this call.
 * @param objToMerge - Source object whose properties are copied into `ogObj`.
 * @returns The merged `ogObj`.
 *
 * @internal
 */

export const mergeObjects = <O extends UnknownRecord, M extends UnknownRecord>(ogObj: O, objToMerge: M): O & M => {

    for (const [k, v] of Object.entries(objToMerge)) {
        validateKey(k);
        (ogObj as UnknownRecord)[k] = v;
    }

    return ogObj as O & M;
}

/**
 * Type guard that returns `true` if `value` is a non-null, non-array plain object.
 *
 * @param value - Value to test.
 * @returns `true` when `value` is a plain `Record`-style object.
 *
 * @internal
 */

export const isObject = <T extends Record<string | number, unknown>>(value: unknown): value is T => {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
};

/**
 * Recursively removes all `null` and `undefined` fields from a plain object, up to a maximum depth of 10.
 *
 * Arrays are preserved as-is - only object properties are stripped.
 * This is intentional: array slots have positional semantics and silently removing `null` elements would shift indices.
 *
 * @param obj - Source object to strip.
 * @param count - Current recursion depth (internal use only; omit when calling externally).
 * @returns A new object with all `null`/`undefined` fields removed.
 *
 * @throws {Error} If the object nesting exceeds 10 levels.
 *
 * @example
 * ```ts
 * removeNullableFields({ a: 1, b: null, c: { d: undefined, e: 2 } }) 
 * output = { a: 1, c: { e: 2 } }
 * ```
 */

export const removeNullableFields = <T extends UnknownRecord>(obj: T, count = 0): NonNullable<T> => {
    if (count >= MAX_DEPTH_FOR_RECORD) throw new Error("Max depth reached! Object is too deep to remove nullable fields.")
    let result = {} as NonNullable<T>;

    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) {
            continue;
        } else if (typeof v === "object" && !Array.isArray(v)) {
            (result as UnknownRecord)[k] = removeNullableFields(v as T, count + 1);
        } else {
            (result as UnknownRecord)[k] = v;
        }
    }

    return result;
}
