
/**
 * @file atomicMutation.ts
 * @description Atomic multi-operation mutations for RedisJSON documents via a server-side Lua script.
 *
 * ### Why Lua?
 * RedisJSON does not expose a native multi-command transaction that can both validate field types *and* conditionally execute a set of mutations as a single atomic unit.
 * By loading a Lua script with `SCRIPT LOAD` and invoking it via `EVALSHA`, we guarantee that:
 *
 * 1. **Snapshot.** Before any operation runs, the script captures the full current document with `JSON.GET`.
 * 2. **Execute with inline validation.** Operations are processed one by one in order. Each operation validates its precondition (type check, path existence) and - if the check passes - executes immediately. If a validation fails, the error is recorded and all remaining executions are skipped.
 * 3. **Rollback on error.** If any error was recorded, the script restores the document to the pre-run snapshot and returns the error list. If the document did not exist before the batch ran, it is deleted instead of restored.
 * 4. **Return.** On success, the script returns either the per-operation results, the post-mutation document, or the pre-mutation snapshot - depending on `resultMode`.
 * 
 * This means:
 * - **No partial mutations.** The moment any operation fails, the snapshot is restored. The document is always either fully updated or completely unchanged.
 * - **Sequential type awareness.** Because validation and execution are interleaved rather than separated into two phases, an earlier operation in the same batch can create or change a field that a later operation then validates against.
 * - **No extra round-trips.** Snapshot, mutation, optional document return, and rollback all happen inside one server-side script execution.
 * 
 * ### Script caching
 * The compiled Lua SHA is cached per Redis instance in a `WeakMap` so the `SCRIPT LOAD` round-trip only happens once per connection.
 * On `NOSCRIPT` errors (e.g. after a Redis flush) the cache is invalidated and the script is reloaded automatically (up to 3 retries).
 */

import Redis from "ioredis";
import { LuaMutation, LuaAtomicMutationReturnMode } from "./types/lua";
import { MAX_BYTES_FOR_LUA_MUTATION } from "~/shared/lib/constants";
import { atomicRedisJsonMutationScript } from "~/shared/scripts/atomicRedisJsonMutation"
import { handleMultipleErrors } from "~/shared/lib/utils";

/**
 * Per-Redis-instance cache of the loaded Lua script SHA.
 *
 * Using a `WeakMap` means entries are automatically garbage-collected when their Redis instance is collected - no manual cleanup needed.
 *
 * @internal
 */

const SCRIPT_CACHE = new WeakMap<Redis, Promise<string>>();

/**
 * Loads the atomic-mutation Lua script into Redis (if not already cached) and returns its SHA hash for use with `EVALSHA`.
 *
 * The `SCRIPT LOAD` round-trip only happens **once per Redis instance**.
 * Subsequent calls resolve from the in-process cache immediately.
 *
 * @param redis - A connected `Redis` instance (not a pipeline).
 * @returns Promise resolving to the SHA1 hash of the loaded script.
 *
 * @internal
 */

const loadScript = async (redis: Redis): Promise<string> => {
    if (!SCRIPT_CACHE.has(redis)) {
        SCRIPT_CACHE.set(
            redis,
            redis.script("LOAD", atomicRedisJsonMutationScript) as Promise<string>
        );
    }
    return SCRIPT_CACHE.get(redis) as Promise<string>;
};

/**
 * Executes a stack of RedisJSON mutations atomically via a server-side Lua script.
 *
 * The script uses a **snapshot-and-rollback** strategy to guarantee atomicity.
 * Operations are processed one by one in order. Each operation validates its precondition (type check, path existence) and - if the check passes - executes immediately. If a validation fails, the error is recorded and all remaining executions are skipped.
 * If any error was recorded, the script restores the document to the pre-run snapshot and returns the error list. If the document did not exist before the batch ran, it is deleted instead of restored.
 * This makes the function suitable as a building block for optimistic-locking patterns and multi-field update flows.
 *
 * ### Constraints
 * - **Minimum 1 operation**, maximum **1,000 operations** per call.
 * - Total serialised `ARGV` payload must not exceed **50 MB**.
 *
 * ### Retry behaviour
 * On a `NOSCRIPT` error (which occurs when Redis has been flushed and the cached script SHA is no longer valid),
 * the script is reloaded and the call is retried up to **3 times** automatically.
 *
 * @param redis - A connected `Redis` instance. Must **not** be a pipeline / `ChainableCommander`.
 * @param key - Redis key of the target JSON document.
 * @param mutations - Ordered list of mutation operations to apply atomically.
 * @param resultMode - What to return; see {@link LuaAtomicMutationReturnMode}.
 * @param retryCount - Internal retry counter; **do not pass this manually**.
 * @returns
 *   - `resultMode === "none"`: array of per-operation results from Redis.
 *   - `resultMode === "mutated"`: the full JSON document after all mutations.
 *   - `resultMode === "nonMutated"`: the full JSON document before mutations.
 *
 * @throws {Error} If `mutations` is empty or exceeds 1,000 entries.
 * @throws {Error} If the total serialised payload exceeds 50 MB.
 * @throws {Error} If any validation fails (document restored).
 * @throws {Error} On unrecoverable Redis errors (after retries are exhausted).
 *
 * @example
 * ```ts
 * await mutateAtomically(redis, "user:42", [
 *   { op: "set",       path: "$.status",     value: "active" },
 *   { op: "numincrby", path: "$.loginCount", value: 1 },
 * ], "mutated");
 * ```
 */

export async function mutateAtomically(
    redis: Redis,
    key: string,
    mutations: LuaMutation[],
    resultMode: LuaAtomicMutationReturnMode,
    retryCount = 0
) {


    if (mutations.length < 1) {
        throw new Error("Mutation stack is empty in atomic mutation!")
    } else if (mutations.length > 1000) {
        throw new Error("Mutation stack limit exceed! Too many operations are being performed at once.")
    }

    const sha = await loadScript(redis);

    const argv: string[] = [];

    for (const mutation of mutations) {

        switch (mutation.op) {
            case "set":
            case "merge":
            case "strappend": {
                argv.push(
                    mutation.op,
                    mutation.path,
                    JSON.stringify(mutation.value)
                );
                continue;
            }
            case "del":
            case "toggle": {
                argv.push(
                    mutation.op,
                    mutation.path
                );
                continue;
            }
            case "numincrby":
            case "nummultby": {
                argv.push(
                    mutation.op,
                    mutation.path,
                    String(mutation.value)
                );
                continue;
            }
            case "arrappend": {
                const { values } = mutation

                if (!values || values.length < 1) {
                    throw new Error("There must be at least one value to append in arrAppend!")
                }

                argv.push(
                    "arrappend",
                    mutation.path,
                    String(values.length),
                    ...values.map(v => JSON.stringify(v))
                );
                continue;
            }
            case "arrinsert": {
                const { values } = mutation;

                if (!values || values.length < 1) {
                    throw new Error("There must be at least one value to insert in arrInsert!")
                }

                argv.push(
                    "arrinsert",
                    mutation.path,
                    String(mutation.index),
                    String(values.length),
                    ...values.map(v => JSON.stringify(v))
                );
                continue;
            }
            case "arrpop": {
                if (mutation.index !== undefined && Number.isInteger(mutation.index)) {
                    argv.push(
                        "arrpop",
                        mutation.path,
                        String(mutation.index)
                    );

                } else {
                    argv.push("arrpop", mutation.path);
                }
                continue;
            }
            case "arrtrim": {

                if (
                    mutation.start === undefined ||
                    mutation.stop === undefined ||
                    !Number.isInteger(mutation.start) ||
                    !Number.isInteger(mutation.stop)
                ) {
                    throw new Error("Start and Stop are required and must be numbers in arrTrim.")
                }

                argv.push(
                    "arrtrim",
                    mutation.path,
                    String(mutation.start),
                    String(mutation.stop),
                );
                continue;
            }
        }
    }

    let totalBytes = 0;

    for (const arg of argv) {
        totalBytes += Buffer.byteLength(arg, "utf8");
    }

    if (totalBytes > MAX_BYTES_FOR_LUA_MUTATION) {
        throw new Error("Mutation payload too large");
    }

    try {
        const response = await redis.evalsha(
            sha,
            1,
            key, // KEYS[1]
            String(mutations.length), // ARGV[1]
            resultMode, // ARGV[2]
            ...argv
        );

        const [success, resultsOrErrors] = response as [number, unknown[]];

        if (success === 1) {
            return resultsOrErrors;
        } else {
            throw new Error(handleMultipleErrors(resultsOrErrors as (string | Error)[]))
        }
    }

    catch (e: any) {

        if (e.message.includes("NOSCRIPT") && retryCount < 3) {
            SCRIPT_CACHE.delete(redis);
            return mutateAtomically(
                redis,
                key,
                mutations,
                resultMode,
                retryCount + 1,
            );
        }

        throw e;
    }
}