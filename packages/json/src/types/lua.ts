
/**
 * Controls what `mutateAtomically` returns after executing the mutation stack.
 *
 * | Value          | Return value                                      |
 * |----------------|---------------------------------------------------|
 * | `"none"`       | The raw array of per-operation results (default). |
 * | `"mutated"`    | The full document **after** all mutations.        |
 * | `"nonMutated"` | The full document **before** any mutations.       |
 */

export type LuaAtomicMutationReturnMode = "nonMutated" | "mutated" | "none";


/**
 * A single mutation operation that can be included in an atomic batch.
 *
 * All `path` values follow Redis JSON's dot-notation path format (e.g. `"$.user.name"` or `".tags[0]"`).
 * Prefer JSONPath `$`-prefixed paths for new code.
 *
 * @example
 * ```ts
 * const mutations: LuaMutation[] = [
 *   { op: "set",       path: "$.status",     value: "active" },
 *   { op: "numincrby", path: "$.loginCount", value: 1 },
 *   { op: "arrappend", path: "$.tags",       values: ["beta"] },
 * ];
 * ```
 */

export type LuaMutation =
    | {
        /** Overwrite (or create) a field at `path` with `value`. */
        op: "set";
        path: string;
        value: unknown;
    }
    | {
        /** Delete the field (or whole document when `path` is `"$"`). */
        op: "del";
        path: string;
    }
    | {
        /**
         * Append `value` to the end of a string field.
         * The field **must** already exist and be of type `string`.
         * Whitespace is not inserted automatically - include it in `value` if needed.
         */
        op: "strappend";
        path: string;
        value: string;
    }
    | {
        /**
         * Increment a numeric field by `value`.
         * The field **must** already exist and be of type `integer` or `number`.
         */
        op: "numincrby";
        path: string;
        value: number;
    }
    | {
        /**
         * Multiply a numeric field by `value`.
         * The field **must** already exist and be of type `integer` or `number`.
         */
        op: "nummultby";
        path: string;
        value: number;
    }
    | {
        /**
         * Append one or more `values` to the end of an array field.
         * The field **must** already exist and be of type `array`.
         */
        op: "arrappend";
        path: string;
        values: unknown[];
    }
    | {
        /**
         * Insert one or more `values` into an array field before the given `index`.
         * The field **must** already exist and be of type `array`.
         * Use `arrappend` to insert at the very end.
         */
        op: "arrinsert";
        path: string;
        index: number;
        values: unknown[];
    }
    | {
        /**
         * Remove and return the element at `index` from an array field.
         * When `index` is omitted the **last** element is popped.
         * The field **must** already exist and be of type `array`.
         */
        op: "arrpop";
        path: string;
        index?: number;
    }
    | {
        /**
         * Retain only the sub-array from `start` to `stop` (inclusive).
         * Elements outside this range are discarded.
         * The field **must** already exist and be of type `array`.
         */
        op: "arrtrim";
        path: string;
        start: number;
        stop: number;
    }
    | {
        /**
         * Flip a boolean field (`true` -> `false`, `false` -> `true`).
         * The field **must** already exist and be of type `boolean`.
         */
        op: "toggle";
        path: string;
    }
    | {
        /**
         * Deep-merge `value` (a plain object) into the object at `path`.
         * The target field **must** already exist and be of type `object`.
         * Existing keys are overwritten; new keys are added; no keys are removed (use `set` + `del` for that).
         */
        op: "merge";
        path: string;
        value: Record<string, unknown>;
    };