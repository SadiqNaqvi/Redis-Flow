/**
 * @file explain.ts
 *
 * Provides static analysis of a Redis Aggregator pipeline without executing anything against Redis - inspired by MongoDB's `cursor.explain()`.
 *
 * The entry point is `explainStages()`, which is called internally by `RedisAggregator.explain()`.
 *
 * @example
 * const plan = aggregator
 * .push({ method: 'redis_get', key: 'user:123', storeAs: 'user' })
 * .commit()
 * .derive('fullName', store => `${store.get('user').first} ${store.get('user').last}`)
 * .explain();
 *
 * console.log(plan.summary);
 * plan.entries.forEach(entry => {
 * if (entry.kind === 'batch') console.log('BATCH', entry.batch.batchIndex, entry.batch.commands);
 * if (entry.kind === 'stage') console.log('STAGE', entry.stage.method, '-', entry.stage.description);
 * });
 */

import { isRedisJsonStage, isRedisStage, validateStages } from './tools';
import { ExplainedCommand, ExplainEntry, ExplainResult } from './types';
import type {
    BranchStage,
    ExtendedRedisStage,
    Stage,
    ValidationStage
} from './types/aggregator';



// Internal Helpers


/**
 * Produces a human-readable sentence describing what a Redis or RedisJSON command does.
 * Used to populate `ExplainedCommand.description`.
 *
 * @internal
 */

const describeCommand = (stage: ExtendedRedisStage): string => {
    const storesAs = stage.storeAs || stage.key;

    // Redis Json command
    if (isRedisJsonStage(stage)) {
        const cmd = stage.method.replace('json_', '');
        const pathPart = 'path' in stage
            ? ` at FieldPath "${stage.path}"`
            : ' (root document)';
        return `JSON.${cmd} on key "${stage.key}"${pathPart} -> stored as "${storesAs}"`;
    }

    // Redis command
    const cmd = stage.method.replace('redis_', '').toUpperCase();
    const argsPart = 'args' in stage && Array.isArray(stage.args) && stage.args.length
        ? ` with args [${stage.args.map(String).join(', ')}]`
        : '';
    return `${cmd} "${stage.key}"${argsPart} -> stored as "${storesAs}"`;
};

/**
 * Converts a Redis or RedisJSON stage into a fully annotated `ExplainedCommand`.
 *
 * @internal
 */

const toExplainedCommand = (stage: ExtendedRedisStage, index: number): ExplainedCommand => {
    const base: ExplainedCommand = {
        index,
        method: stage.method,
        key: stage.key,
        storesAs: stage.storeAs || stage.key,
        description: describeCommand(stage),
    };

    if ('args' in stage && Array.isArray(stage.args)) {
        base.args = stage.args;
    }
    if ('path' in stage) {
        base.path = stage.path;
    }

    return base;
};


// Core: explainStages


/**
 * Performs a static analysis of a stages array and returns an `ExplainResult` describing the execution plan, without touching Redis.
 *
 * This is the function backing `RedisAggregator.explain()`. You can also call it with a raw `Stage[]` array.
 *
 * **What it does:**
 * - Runs `validateStages` and records any structural error (sets `valid: false`).
 * - Walks each stage and annotates it with a human-readable description.
 * - Groups consecutive `redis_*` / `json_*` stages into `ExplainedBatch` entries, mirroring how `commit` flushes them in a single pipeline call and fills the store with their result.
 * - Generates `warnings` for patterns that are valid but limit static analysis (e.g. `branch` stages whose commands are resolved at runtime).
 * - Builds a plain-English `summary`.
 *
 * **What it does NOT do:**
 * - Execute any Redis command.
 * - Call any user-supplied callbacks (validate, derive, transform, branch).
 * - Throw on invalid pipelines - errors appear in `valid` / `validationError` so callers can display them gracefully.
 *
 * @param stages - The stages array to analyse.
 * @returns - A fully populated `ExplainResult`.
 *
 * @example
 * const plan = explainStages([
 * { method: 'redis_get', key: 'user:1', storeAs: 'user' },
 * { method: 'commit' },
 * { method: 'windup', value: store => store.get('user') },
 * ]);
 * console.log(plan.summary);
 */

export const explainStages = <T>(stages: Stage<T>[], isChaining: boolean): ExplainResult => {
    const warnings: string[] = [];
    const entries: ExplainEntry[] = [];

    let valid: boolean = true;
    let validationError: string | undefined;

    // Validation
    try {
        validateStages(stages);
    } catch (err: any) {
        valid = false;
        validationError = err.message as string;
        warnings.push(`Validation error: ${err.message}`);
    }

    // Warn if explain is called before a windup is present
    const hasWindup = stages.some(s => s.method === 'windup');
    if (!isChaining && !hasWindup) {
        warnings.push(
            'No "windup" stage found. The aggregator would not return the result you expect. Add a "windup" stage at the end of the pipeline stages.'
        );
    }

    // Walk stages
    let batchIndex = 0;
    let totalCommands = 0;
    let pendingBatchCmds: ExplainedCommand[] = [];

    for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];

        // redis_* / json_* queue into the current open batch
        if (isRedisStage(stage) || isRedisJsonStage(stage)) {
            const cmd = toExplainedCommand(stage as ExtendedRedisStage, i);
            pendingBatchCmds.push(cmd);
            totalCommands++;
            continue;
        }

        // commit close the pending batch and emit both entries
        if (stage.method === 'commit') {
            // Emit the batch first, then the commit marker directly after it.
            // This preserves the mental model: "here are the commands, then they get flushed."
            entries.push({
                kind: 'batch',
                batch: {
                    batchIndex,
                    commands: [...pendingBatchCmds],
                    redisRoundTrips: 1,
                },
            });

            const cmdWord = pendingBatchCmds.length === 1 ? 'command' : 'commands';
            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'commit',
                    description:
                        `Flush pipeline batch #${batchIndex} ` +
                        `(${pendingBatchCmds.length} ${cmdWord}, 1 Redis round-trip) ` +
                        `and map results into the store`,
                    meta: { batchIndex, commandCount: pendingBatchCmds.length },
                },
            });

            batchIndex++;
            pendingBatchCmds = [];
            continue;
        }

        // branch dynamic; warn and leave a placeholder
        if (stage.method === 'branch') {
            const branchStage = stage as BranchStage;
            warnings.push(
                `Stage [${i}] is a "branch" stage.` +
                `The Redis commands it injects are resolved at runtime from the current store state and cannot be statically analyzed.` +
                `The real pipeline may have more batches and commands.`
            );

            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'branch',
                    description:
                        `⚠ Dynamic branch - injects additional Redis commands at runtime based on current store state` +
                        (branchStage.ref ? ` (reads store key "${branchStage.ref}")` : '') +
                        `. Exact commands are not known until execution.`,
                    meta: {
                        ref: branchStage.ref,
                        dynamic: true,
                    },
                },
            });
            continue;
        }

        // validate
        if (stage.method === 'validate') {
            const vs = stage as ValidationStage;
            const refPart = vs.ref ? ` against store key "${vs.ref}"` : '';
            const failurePart = vs.messageOnFailure ? `. Failure message: "${vs.messageOnFailure}"` : '';
            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'validate',
                    description: `Assert condition${refPart}${failurePart}`,
                    meta: {
                        ref: vs.ref,
                        messageOnFailure: vs.messageOnFailure,
                    },
                },
            });
            continue;
        }

        // derive
        if (stage.method === 'derive') {
            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'derive',
                    description: `Compute a value and store it in the aggregation store`,
                },
            });
            continue;
        }

        // transform
        if (stage.method === 'transform') {
            const ts = stage;
            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'transform',
                    description:
                        `Apply transformations to the store (reads store key "${ts.key}")`,
                    meta: { key: ts.key },
                },
            });
            continue;
        }

        // windup
        if (stage.method === 'windup') {
            entries.push({
                kind: 'stage',
                stage: {
                    index: i,
                    method: 'windup',
                    description:
                        `Assemble the final return value from the store. Pipeline ends here.`,
                },
            });
            // Nothing declared after windup is reachable, so we stop.
            break;
        }

        // Unknown stage - should not reach here if validateStages passed 
        warnings.push(
            `Stage [${i}] has an unrecognized method "${(stage as any).method}" ` +
            `and was skipped during explain.`
        );
    }

    // Build the summary
    const hasBranch = warnings.some(w => w.includes('branch'));
    const dynamicSuffix = hasBranch
        ? ' (plus runtime-injected commands from branch stage(s))'
        : '';
    const roundTripNote = batchIndex > 0
        ? `Each batch costs exactly 1 Redis round-trip, for a minimum of ${batchIndex} round-trip(s).`
        : 'No pipeline batches found - make sure redis/json stages are present before commit.';
    const warningNote = warnings.length > 0
        ? `${warnings.length} warning(s). See the "warnings" array for details.`
        : '';

    const summary = [
        `Pipeline has ${stages.length} stage(s) across ${batchIndex} Redis pipeline batch(es)`,
        `executing ${totalCommands} command(s)${dynamicSuffix}.`,
        roundTripNote,
        warningNote,
    ].filter(Boolean).join(' ');

    return {
        valid,
        ...(validationError !== undefined ? { validationError } : {}),
        totalStages: stages.length,
        totalBatches: batchIndex,
        totalCommands,
        entries,
        warnings,
        summary,
    };
};