import { RedisJsonAccessCommands } from "~/shared/core/RedisJson";
import { Redis } from "ioredis";
import { AllowedRedisMethods, RedisJsonStage, RedisStage } from "./redisExtendedStages";
import { PipelineResponseHandlerFunction } from "~/shared/types";

export type RedisInstance = Redis;

export type TypedStore = {
    set(key: string, value: unknown): void
    clear(): void
    readonly(): AggregatorStore
} & AggregatorStore

export type AggregatorStore = {
    get<T extends unknown>(key: string): T;
    has(key: string): boolean;
    keys(): string[];
    values(): unknown[];
    entries(): [string, unknown][];
};

export type RedisJsonMethod<C extends RedisJsonAccessCommands = RedisJsonAccessCommands> = `json_${C}`;

export type AggregateHelperMethods = "commit" | "transform" | "validate" | "derive" | "branch" | "windup";

export interface BaseStage {
    readonly method: AllowedRedisMethods | RedisJsonMethod | AggregateHelperMethods;
}

export type ExtendedRedisStage = RedisStage | RedisJsonStage;

export interface CommitStage extends BaseStage {
    method: 'commit';
    allowEmptyBatch?: boolean;
}

export interface ValidationStage extends BaseStage {
    method: 'validate';
    ref?: string;
    messageOnFailure?: string,
    validate: (store: AggregatorStore, val?: any) => boolean | Promise<boolean>;
}

export interface BranchStage extends BaseStage {
    method: 'branch';
    ref?: string;
    explore: (store: AggregatorStore, val?: any) => ExtendedRedisStage[] | Promise<ExtendedRedisStage[]>;
}

export interface DeriveStage extends BaseStage {
    method: 'derive';
    ref?: string;
    vals: (store: AggregatorStore, val: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface TransformStage extends BaseStage {
    method: "transform";
    key: string;
    transform: (store: AggregatorStore, value: any) => unknown | Promise<unknown>;
};

export interface WindupStage<T = unknown> extends BaseStage {
    method: "windup";
    value: (store: AggregatorStore) => T | Promise<T>;
}

export type Stage<T> =
    | RedisStage
    | RedisJsonStage
    | CommitStage
    | ValidationStage
    | BranchStage
    | DeriveStage
    | TransformStage
    | WindupStage<T>

export type Merge<A, B> = Omit<A, keyof B> & B;

export type RedisMethodReturnType = {
    [K in AllowedRedisMethods]: ReturnType<Redis[K]>
}

export type AggregatorConfig = {

    /**
     * When `true`, Aggregator logs important information in the terminal for debugging purpose.
     * 
     * defaults: `false`
     */

    debug?: boolean,

    /**
     * When `true`, Aggregator will not throw `Error` instead return `null`
     * 
     * defaults: `false`
     */

    swallowErrorOnEmptyPipeline?: boolean,

    /**
     * Custom pipeline response normaliser.
     * 
     * The Aggregator uses `redis.pipeline()` to reduce round trips (RTT).
     * By default, we use our own pipeline response handler. But you can pass a custom response handler.
     * It should be a function that handles pipeline response returned by redis.pipeline().
     * The response can be of type `[error: Error | null, response: unknown]` or `[response: unknown]` or unknown.
     * 
     * **It must only return array of results.**
     */

    pipelineResponseHandler?: PipelineResponseHandlerFunction;

    /**
     * Set if errors returned by the pipeline (probably of type `[error: Error|null, response: unknown]`) should be thrown or swallowed.
     * If set to `true`, pipeline errors would be silently ignored and the value for those keys would be `null` or `undefined`.
     *
     * If `pipelineResponseHandler` function is provided, this value will not be used.
     * 
     * default: `false`
     */

    swallowPipelineErrors?: boolean,

    /**
     * Timeout in seconds. Abort if aggregation exceeds this duration.
     * 
     * @throws {Error}
     * 
     * default - 10 seconds
     */

    timeoutInSeconds?: number,

    /**
     * Keep sparse array indices from `JSON_*` responses.
     * 
     * When true, Array fields may or may not look similar to this: `[empty x 2, value, empty, value]` depending on the array and targeted indices.
     * 
     * @default false
     */

    preserveArrayIndices?: boolean,


    /**
     * AbortSignal for cancellation.
     */

    signal?: AbortSignal,


}