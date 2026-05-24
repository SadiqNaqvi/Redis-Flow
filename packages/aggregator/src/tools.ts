/**
 * @file tools.ts
 *
 * Pure utility functions shared across the aggregator. These are deliberately stateless and side-effect free so they can be unit-tested in isolation.
 *
 * Responsibilities:
 * - Stage type-guard predicates (`isRedisStage`, `isRedisJsonStage`)
 * - Pipeline structural validation (`validateStages`)
 */

import { RedisJsonStage, RedisStage } from "@/types/redisExtendedStages";
import { RedisJsonAccessor } from "~/shared/core/RedisJson";
import Redis from "ioredis";
import { Stage } from "./types";

/**
 * Type-guard that returns `true` when the stage is a `RedisStage` (i.e. its method is prefixed with `"redis_"` and maps to a real ioredis command).
 *
 * @throws {Error} If the method starts with `"redis_"` but is not a valid ioredis command.
 * This surfaces the mistake early - at chain-build time - rather than silently failing inside the executor.
 *
 * @example
 * isRedisStage({ method: 'redis_get', key: 'user:1' })   // -> true
 * isRedisStage({ method: 'json_get',  key: 'user:1' })   // -> false
 * isRedisStage({ method: 'redis_fly', key: 'user:1' })   // -> throws Error
 */

export const isRedisStage = <T>(s: Stage<T>): s is RedisStage => {
    if (!s.method.startsWith('redis_')) return false;

    const method = s.method.replace("redis_", '');

    // Check the prototype so class methods (non-enumerable) are found correctly.
    // Using `command in Redis` would only find static/own properties.
    if (method in Redis.prototype) return true;

    throw new Error(`Invalid Redis Stage! Expected a valid Redis Stage, got ${method}`);
}

/**
 * Type-guard that returns `true` when the stage is a `RedisJsonStage` (i.e. its method is prefixed with `"json_"` and maps to a real RedisJSON command).
 *
 * @throws {Error} If the method starts with `"json_"` but is not a valid RedisJSON command.
 * Detected early so you never get a silent no-op in the executor.
 *
 * @example
 * isRedisJsonStage({ method: 'json_get', key: 'doc:1' })    // -> true
 * isRedisJsonStage({ method: 'redis_get', key: 'doc:1' })   // -> false
 * isRedisJsonStage({ method: 'json_fly',  key: 'doc:1' })   // -> throws Error
 */

export const isRedisJsonStage = <T>(s: Stage<T>): s is RedisJsonStage => {
    if (!s.method.startsWith("json_")) return false;

    const method = s.method.replace("json_", '');

    // Check the prototype (see note in isRedisStage utility function).
    if (method in RedisJsonAccessor.prototype) return true;

    throw new Error(`Invalid Redis JSON Stage! Expected a valid Redis JSON Stage, got ${method}`);
}

/**
 * Validates the structural rules of an aggregation stages array and throws a descriptive `Error` on the **first** violation found.
 *
 * Calling this early (before touching Redis) means misconfigured pipelines are caught at build time, not buried inside async stack traces.
 *
 * **Rules enforced:**
 * 1. The array must not be empty.
 * 2. The first stage must be a `redis_*` or `json_*` stage.
 * 3. The last stage must be `"windup"`.
 * 4. There must be exactly one `"windup"` stage.
 * 5. Every `redis_*`, `json_*`, or `"branch"` stage must eventually be followed by a `"commit"` stage before the next non-pipeline stage.
 *    Two consecutive `"commit"` stages with nothing pipeline-like between them are also rejected.
 *
 * @param stages - The stages array to validate.
 * @throws {Error}  Descriptive error naming the rule that was violated.
 *
 * @example
 * // Throws: "First stage must be either redis or redis-json stage, got: validate"
 * validateStages([
 *   { method: 'validate', validate: () => true },
 *   { method: 'windup',   value: store => store.get('x') },
 * ]);
 */

export const validateStages = <T>(stages: Stage<T>[]) => {

    // ── Rule 1: non-empty
    if (!stages.length)
        throw new Error("Empty stages in Redis Aggregator");

    const [first] = stages;
    const last = stages[stages.length - 1];

    // Rule 2: first stage must be a redis or redis-json stage
    if (!(isRedisStage(first) || isRedisJsonStage(first)))
        throw new Error(`Redis Aggregator Error: First stage must be either redis or redis-json stage, got: ${first.method}`);

    // Rule 3: last stage must be windup
    else if (last.method !== "windup")
        throw new Error(`Redis Aggregator Error: Last stage must be return stage, got: ${last.method}`);

    // Rule 4: exactly one windup
    else if (stages.filter(s => s.method === "windup").length > 1)
        throw new Error("Redis Aggregator Error: There must be only 1 return stage.");

    // Rule 5: every pipeline stage must be followed by a commit

    // `flag` is true whenever we're "inside" a pipeline segment - i.e. after a redis/json/branch stage and before its matching commit. 
    // The invariant is: flag must be true when a commit is encountered, and false when any other non-pipeline stage is encountered.

    let flag = false;

    stages.forEach((stage, i) => {

        // If there is a redis, redis-json or branch stage - turn the flag on. Because these stages get data from redis.
        if (isRedisStage(stage) || isRedisJsonStage(stage) || stage.method === "branch") {

            // Entering (or staying in) a pipeline segment.
            flag = true;

        } else if (stage.method === "commit") {

            // Commit closes the pipeline segment - reset the flag.
            if (flag) flag = false;

            // Two consecutive commit stages without any redis, redis-json or branch stages between them, or a commit with nothing before 
            else throw new Error(
                `Unexpected 'commit' stage at index ${i}. There must be at least one redis, redis-json, or branch stage before each commit.`
            );
        }

        // A non-pipeline stage (validate/derive/transform/windup) appeared while flag is still true - the user forgot a commit.

        else if (flag) {
            throw new Error(
                `Redis Aggregator Error: Expected a commit stage after redis, redis-json or branch stages, got ${stage.method} at index ${i}. `
                +
                `Insert a 'commit' before this stage.`
            );
        }
    });
}