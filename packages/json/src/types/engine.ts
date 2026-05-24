import { RedisJsonAccessCommandsMap, RedisJsonAccessorConfig, RedisJsonConfig } from "~/shared/core/RedisJson";
import Redis, { ChainableCommander } from "ioredis";
import { RedisJson } from "../engine";
import { ArrAppendMethodOverload, ArrInsertMethodOverload, ArrPopMethodOverload, ArrTrimMethodOverload, DeleteMethodOverload, MergeMethodOverload, NumberMethodOverload, PatchMethodOverload, SetMethodOverload, StrAppendMethodOverload, ToggleMethodOverload, UpdateMethodOverload } from "./overload";

export * from "~/shared/types"
export * from "~/shared/core/RedisJson/types"

type RedisOrPipeline = Redis | ChainableCommander;

export type RedisJsonReturn<R extends RedisOrPipeline, T> = R extends Redis ? Promise<T> : RedisJson<R>

export type RedisJsonMutationCommandsMap<R extends RedisOrPipeline = RedisOrPipeline> = {
    set: SetMethodOverload<R>,
    patch: PatchMethodOverload<R>,
    update: UpdateMethodOverload<R>,
    merge: MergeMethodOverload<R>,
    del: DeleteMethodOverload<R>,
    strAppend: StrAppendMethodOverload<R>,
    numIncrBy: NumberMethodOverload<R>,
    numMultBy: NumberMethodOverload<R>,
    arrAppend: ArrAppendMethodOverload<R>,
    arrInsert: ArrInsertMethodOverload<R>,
    arrTrim: ArrTrimMethodOverload<R>,
    arrPop: ArrPopMethodOverload<R>,
    toggle: ToggleMethodOverload<R>,
}

export type RedisJsonMethodsMap = RedisJsonAccessCommandsMap & RedisJsonMutationCommandsMap

export type RedisJsonCommands = keyof RedisJsonMethodsMap;
export type RedisJsonMutationCommands = keyof RedisJsonMutationCommandsMap;

export type RedisJsonMutatorConfig = {
    returns?: "mutated document" | "non mutated document"
} & RedisJsonConfig & RedisJsonAccessorConfig;