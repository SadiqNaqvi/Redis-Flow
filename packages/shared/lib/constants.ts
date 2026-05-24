
/**
 * Set of property names that must never be used as Redis key segments.
 *
 * Writing to `__proto__`, `prototype`, or `constructor` via dynamic property assignment is the canonical prototype-pollution attack vector.
 *
 * @internal
 */

export const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);


/**
 * Maximum total byte size of all `ARGV` values passed to the Lua script for Atomic Mutation.
 *
 * Redis default `proto-max-bulk-len` is 512 MB, but keeping individual Lua calls well under that limit avoids latency spikes and memory pressure.
 * 50 MB is a conservative limit for a single atomic mutation batch.
 *
 * @internal
 */
export const MAX_BYTES_FOR_LUA_MUTATION = 50_000_000;


/** Maximum path nesting depth before we refuse to traverse further. @internal */
export const MAX_DEPTH_FOR_RECORD = 10;


/**
 * Maximum safe array index accepted from Redis JSON path strings.
 *
 * Indices beyond this threshold would cause `setDeep` to materialise a sparse array with tens-of-thousands of `undefined` slots, which would be a denial-of-service footgun.
 *
 * @internal
 */
export const MAX_ARRAY_INDEX = 100_000;
