
/**
 * A single Redis or RedisJSON command queued inside a pipeline batch.
 * Corresponds to one `redis_*` or `json_*` stage in the original array.
 */

import { FieldPath } from "~/shared/types";

export interface ExplainedCommand {

    /** Zero-based index of this stage in the original stages array. */
    index: number;

    /**
     * The raw method string, e.g. `"redis_get"` or `"json_get"`.
     * Stripping the prefix gives the underlying Redis command.
     */
    method: string;

    /** The Redis key this command operates on. */
    key: string;

    /**
     * The key under which this command's result will be stored in the aggregation store after the following `commit` stage runs.
     * Equals `stage.ref` when provided, otherwise `stage.key`.
     */
    storesAs: string;

    /**
     * Extra arguments passed to the Redis command (e.g. field names for `HGET`, scores for `ZADD`).
     * Present only for stages that carry args.
     */
    args?: unknown[];

    /**
     * FieldPath expression for `json_*` stages that accept a path.
     * Absent for commands that operate on the root document (e.g. `json_get` without a path).
     */
    path?: FieldPath;

    /** Human-readable description of what this command does. */
    description: string;
}

/**
 * A group of Redis/RedisJSON commands batched together in a single pipeline and flushed to Redis in one round-trip by a `commit` stage.
 */

export interface ExplainedBatch {
    /** Zero-based batch number. Increments with each `commit` stage. */
    batchIndex: number;

    /** All commands queued in this batch, in the order they were declared. */
    commands: ExplainedCommand[];

    /**
     * Number of Redis round-trips this batch costs.
     * Batching all commands into a pipeline is the key performance benefit of this library.
     * this would be N, where N is the number of commit stages.
     */
    redisRoundTrips: 1;
}

/**
 * Metadata attached to a non-pipeline stage (validate, derive, transform, branch, commit, or windup).
 */

export interface ExplainedStage {
    /** Zero-based index of this stage in the original stages array. */
    index: number;

    /** The stage's method identifier. */
    method: 'validate' | 'derive' | 'transform' | 'branch' | 'commit' | 'windup';

    /** Human-readable explanation of what this stage does. */
    description: string;

    /**
     * Optional extra context specific to the stage type.
     * - `commit` -> `{ batchIndex: number; commandCount: number }`
     * - `branch` -> `{ ref?: string; dynamic: true }`
     * - `validate` -> `{ ref?: string; messageOnFailure?: string }`
     * - `derive` -> `{ ref?: string }`
     */
    meta?: Record<string, unknown>;
}

/**
 * One entry in the ordered explain output.
 * Either a collected pipeline batch (all redis/json stages before a commit) or a single non-pipeline stage.
 *
 * Use the `kind` discriminant to narrow the type:
 * @example
 * for (const entry of plan.entries) {
 *      if (entry.kind === 'batch') {
 *           console.log(`Batch ${entry.batch.batchIndex}: ${entry.batch.commands.length} commands`);
 *      } else {
 *           console.log(`Stage [${entry.stage.index}] ${entry.stage.method}: ${entry.stage.description}`);
 *      }
 * }
 */

export type ExplainEntry =
    | { kind: 'batch'; batch: ExplainedBatch }
    | { kind: 'stage'; stage: ExplainedStage };

/**
 * The full result returned by `RedisAggregator.explain()` or `explainStages()`.
 *
 * Mirrors MongoDB's explain output philosophy: a static query-plan description with no side effects, safe to call in tests or at startup.
 */

export interface ExplainResult {
    /**
     * `true` if the stage stack passes structural validation.
     *
     * A `false` here means the pipeline will definitely throw when `.aggregate()` or `.windup()` is called.
     * The remaining fields still reflect a best-effort partial analysis so you can see what was parsed before the error.
     */
    valid: boolean;

    /**
     * The validation error message. Only present when `valid` is `false`.
     * Matches exactly what `.aggregate()` would throw.
     */
    validationError?: string;

    /** Total number of stages including commit and windup. */
    totalStages: number;

    /**
     * Number of Redis pipeline batches (`commit` stages) in the pipeline.
     * Each batch costs exactly 1 Redis round-trip.
     */
    totalBatches: number;

    /**
     * Total number of statically-known Redis/RedisJSON commands.
     * Commands injected at runtime by `branch` stages are NOT counted because they are resolved from the store during execution.
     */
    totalCommands: number;

    /**
     * Ordered representation of the full pipeline.
     * Redis/RedisJSON commands are grouped into `ExplainedBatch` entries;
     * everything else is an individual `ExplainedStage` entry.
     *
     * Iterating this array top-to-bottom mirrors the actual execution order.
     */
    entries: ExplainEntry[];

    /**
     * Non-fatal notices about patterns that are valid but worth attention.
     * Examples:
     * - `branch` stages are present (cannot be fully statically analyzed)
     * - Errors of failed Validation.
     */
    warnings: string[];

    /**
     * A concise, plain-English summary of the pipeline - suitable for logging at startup or printing in test output.
     *
     * @example
     * `Pipeline has 5 stage(s) across 2 Redis pipeline batch(es) executing 4 command(s).
     * Each batch costs exactly 1 Redis round-trip, for a total of 2 round-trip(s).`
     */
    summary: string;
}
