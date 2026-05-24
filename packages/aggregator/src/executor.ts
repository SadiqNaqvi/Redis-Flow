/**
 * @file executor.ts
 *
 * Low-level pipeline execution utilities. These functions are responsible for:
 *
 * 1. **Parsing** raw Redis responses into JS values (`parseUnknownData`)
 * 2. **Normalising** any value into an array (`returnArray`)
 * 3. **Processing** the raw `pipeline.exec()` result - handling per-command
 *    errors, parsing nested values, and optionally swallowing errors instead
 *    of throwing (`handlePipelineResponse`, `handlePipelineResponseGracefully`)
 * 4. **Mapping** parsed pipeline results back to their store keys (`mapResults`)
 * 5. **Staging** Redis and RedisJSON commands into a pipeline object
 *    (`execStage`, `execJsonStage`)
 * 6. **Running** a full pipeline stack against a Redis instance (`executeStack`)
 *
 * Most functions here are internal implementation details. The only one called
 * from outside this module (by the engine) is `executeStack` and `mapResults`.
 */

import { RedisJsonAccessor, transformRedisResponse } from "~/shared/core/RedisJson";
import { handlePipelineResponse, logForDebug } from "~/shared/lib/utils";
import { JSONObject, RedisJsonAccessCommands, RedisJsonAccessorConfig } from "~/shared/types";
import { PipelineHandlerInput } from "~/shared/types/others.js";
import { ChainableCommander, Redis } from "ioredis";
import { isRedisJsonStage, isRedisStage } from "./tools";
import { AggregatorConfig, ExtendedRedisStage, TypedStore } from "./types/aggregator";
import { AllowedRedisMethods, RedisJsonStage, RedisStage } from "./types/redisExtendedStages";

/**
 * Maps a flat parsed-results array back to the aggregation store under each stage's designated key (`stage.storeAs` if provided, otherwise `stage.key`).
 *
 * The `stack` and `results` arrays must have the same length - each `stack[i]` corresponds to `results[i]`. A length mismatch usually means a custom `pipelineResponseHandler` returned the wrong number of values.
 *
 * **RedisJSON special-casing:**
 * `json_*` stages (except `json_get`) can return path-keyed objects like `{ "$.name": ["Alice"] }` instead of a plain value. `transformRedisResponse` flattens these back to the intended shape before storing.
 *
 * **Duplicate key detection:**
 * Storing two different stages under the same key is almost always a bug. We throw instead of silently overwriting so the mistake surfaces immediately.
 *
 * @param stack - The redis/json stages that were executed.
 * @param results - Parsed pipeline results in the same order.
 * @param store - The aggregation store to write into.
 * @param preserveArrayIndices - Passed to `transformRedisResponse` for array indexing behaviour.
 *
 * @throws {Error} On stack/results length mismatch.
 * @throws {Error} On duplicate store key.
 * @throws {Error} If a stage has neither `storeAs` nor `key`.
 *
 * @internal
 */

export const mapResults = (stack: ExtendedRedisStage[], results: unknown[], store: TypedStore, preserveArrayIndices: boolean) => {

    if (stack.length !== results.length)
        throw new Error(`Mismatch Stack Length. Number of redis/redis-json commands are ${stack.length} whereas number of results from pipeline are ${results.length}. Possible cause: If 'pipelineResponseHandler' function is provided then it is not handling the response well.`);

    stack.forEach((stage, i) => {
        const result = results[i];

        const storeKey = stage.storeAs || stage.key;

        // Guard: key must be a non-empty string
        if (!storeKey) {
            throw new Error(`Invalid Key! Expected a string, got ${storeKey}`)
        }

        // Guard: duplicate key
        else if (store.has(storeKey)) {
            throw new Error(`Duplicate store key "${storeKey}" detected at pipeline result index ${i}. Each redis/json stage must use a unique "storeAs" (or "key" when "storeAs" is absent).`);
        }

        // RedisJSON path-keyed response -> flatten to plain value
        //
        // json_get returns the root document (already a plain object/array), so we skip transformation for it.
        // All other json_* stages may return path-keyed arrays like { "$.field": [value] } that need flattening.
        if (result && isRedisJsonStage(stage)) {
            if (Array.isArray(result) && (!("path" in stage) || !stage.path)) {
                store.set(stage.storeAs || stage.key, result[0]);
            } else if (typeof result === "object" && !Array.isArray(result)) {
                store.set(
                    stage.storeAs || stage.key,
                    transformRedisResponse(result as JSONObject, preserveArrayIndices)
                );
            }
        } else {
            store.set(stage.storeAs || stage.key, result);
        }
    });
}

/**
 * Appends a single `redis_*` stage's command to an ioredis pipeline object.
 *
 * Looks up the command on the pipeline by stripping the `"redis_"` prefix, then calls it with the stage's key and optional args.
 *
 * @param pipeline - An ioredis `ChainableCommander` (pipeline or multi).
 * @param stage - The RedisStage to execute.
 *
 * @throws {Error} If the resolved command name is not a function on the pipeline (should not happen if `isRedisStage` validation passed, but guarded here for belt-and-suspenders safety).
 *
 * @internal
 */

const execStage = (pipeline: ChainableCommander, stage: RedisStage) => {

    const command = stage.method.replace('redis_', '') as AllowedRedisMethods;
    const method = pipeline[command] as (...args: any[]) => any;

    if (typeof method !== "function")
        throw new Error(`Invalid Method! Expected a Redis command but got: ${stage.method}`);

    else if ("args" in stage)
        (pipeline[command] as (...args: any[]) => any)(stage.key, ...stage.args);
    else
        method.call(pipeline, stage.key);

}

/**
 * Appends a single `json_*` stage's command to a `RedisJson` pipeline.
 *
 * Looks up the command by stripping the `"json_"` prefix, then calls it with the key, optional JSONPath, and the strict-array-indexing config flag.
 *
 * @param stage - The RedisJsonStage to execute.
 * @param redisJson - The `RedisJson` pipeline wrapper instance.
 * @param preserveArrayIndices - Passed through to `RedisJson`'s accessor config.
 *
 * @throws {Error} If the resolved command name is not a function on `RedisJson` (same safety net as `execStage`).
 *
 * @internal
 */

const execJsonStage = (stage: RedisJsonStage, redisJson: RedisJsonAccessor<ChainableCommander>, preserveArrayIndices: boolean) => {

    const command = stage.method.replace('json_', '') as RedisJsonAccessCommands;
    const method = redisJson[command] as (...args: any[]) => void;

    if (typeof method !== "function")
        throw new Error(`Invalid Command! Expected a valid Redis Json Command but got: ${command}`);

    else if ("path" in stage) {
        method.call(redisJson, stage.key, stage.path, { preserveArrayIndices } as RedisJsonAccessorConfig);
    } else {
        method.call(redisJson, stage.key);
    }
}

/**
 * Executes a collected stack of redis/json stages as a single batched pipeline call against Redis and returns the parsed results array.
 *
 * **Why a pipeline (or multi)?**
 * Sending N commands individually would incur N network round-trips. 
 * Batching them into one `pipeline.exec()` / `multi.exec()` reduces that to a single round-trip regardless of N - the core performance promise of this library.
 *
 * **Execution flow:**
 * 1. Create a pipeline (`redis.pipeline()`) or multi (`redis.multi()`) based on `config.useMulti`.
 * 2. Iterate the stack and queue each command via `execStage` / `execJsonStage`.
 * 3. Call `pipeline.exec()` and pass the result through either the user-supplied `config.pipelineResponseHandler` or the default `handlePipelineResponse`.
 * 4. Return the parsed results array for `mapResults` to consume.
 *
 * @param redis - The ioredis `Redis` instance.
 * @param stack - The ordered list of redis/json stages to execute.
 * @param config - Aggregator config (useMulti, swallowPipelineErrors, debug, etc.).
 * @returns Parsed results array, one entry per stage in `stack`.
 *
 * @throws {Error} If any pipeline command fails and `swallowPipelineErrors` is `false`.
 *
 * @internal
 */

export const executeStack = async (redis: Redis, stack: ExtendedRedisStage[], config: AggregatorConfig) => {

    const pipeline = redis.pipeline();
    const redisJson = new RedisJsonAccessor(pipeline, { debug: config.debug });

    // Queue all commands. Nothing hits the network until `pipeline.exec()`.
    stack.forEach(stage => {

        if (isRedisJsonStage(stage))
            execJsonStage(stage, redisJson, !!config.preserveArrayIndices);

        else if (isRedisStage(stage)) execStage(pipeline, stage);

        // Should never happen - the engine only calls executeStack with validated redis/json stages.
        else throw new Error(
            `Unexpected stage type in executeStack: "${(stage as any).method}". ` +
            `Only redis_* and json_* stages may be passed to executeStack.`
        );
    });

    // Execute the pipeline in a single round-trip.
    const resp = await pipeline.exec()
        .then((r: PipelineHandlerInput) =>
            handlePipelineResponse(r, !!config.swallowPipelineErrors, config.pipelineResponseHandler)
        );

    logForDebug(!!config.debug, "Redis pipeline returned", resp);
    return resp;
}