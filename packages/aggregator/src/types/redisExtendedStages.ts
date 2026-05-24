import { FieldPath } from "~/shared/types";
import { RedisJsonAccessCommands, RedisJsonAccessorConfig } from "~/shared/types";

type LimitRange = [start: string | number, stop: string | number];
type StartEndRange = [start: string | number, end: string | number];
type StartEndRevRange = [end: string | number, start: string | number];

type ScoreRange = [
    min: string | number,
    max: string | number,
];

type ScoreRevRange = [
    max: string | number,
    min: string | number
];

type WithScores = [
    withScores: "WITHSCORES"
];

type Limit = [
    limitToken: "LIMIT",
    offset: number | string,
    count: number | string
];

export type AllowedRedisMethods =
    | "get"
    | "getBuffer"
    | "mget"
    | "strlen"
    | "getrange"
    | "hget"
    | "hgetall"
    | "hmget"
    | "hkeys"
    | "hvals"
    | "hlen"
    | "hexists"
    | "lindex"
    | "lrange"
    | "llen"
    | "smembers"
    | "sismember"
    | "scard"
    | "srandmember"
    | "zrange"
    | "zrevrange"
    | "zrangebyscore"
    | "zrevrangebyscore"
    | "zscore"
    | "zrank"
    | "zrevrank"
    | "zcard"
    | "zcount"
    | "exists"
    | "type"
    | "ttl"
    | "pttl"
    | "bitcount"
    | "getbit"
    | "pfcount"
    | "xrange"
    | "xrevrange"

type RedisStageBuilder<M extends AllowedRedisMethods, A> = {
    method: `redis_${M}`,
    key: string,
    storeAs?: string,
} & (A extends undefined ? {} : { args: A })

type RedisGetStage = RedisStageBuilder<"get", undefined>;
type RedisGetBufferStage = RedisStageBuilder<"getBuffer", undefined>
// type RedisMultiGetStage = RedisStageBuilder<"mget", undefined, true>
type RedisStringLenStage = RedisStageBuilder<"strlen", undefined>
type RedisGetRangeStage = RedisStageBuilder<"getrange", [...LimitRange]>

type RedisHashGetStage = RedisStageBuilder<"hget", [field: string]>
type RedisHashGetAllStage = RedisStageBuilder<"hgetall", undefined>
type RedisHashMultiGetStage = RedisStageBuilder<"hmget", [...fields: string[]]>
type RedisHashKeysStage = RedisStageBuilder<"hkeys", undefined>
type RedisHashValsStage = RedisStageBuilder<"hvals", undefined>
type RedisHashLenStage = RedisStageBuilder<"hlen", undefined>
type RedisHashExistsStage = RedisStageBuilder<"hexists", [field: string]>

type RedisListIndexStage = RedisStageBuilder<"lindex", [index: string | number]>
type RedisListRangeStage = RedisStageBuilder<"lrange", [...LimitRange]>
type RedisListLenStage = RedisStageBuilder<"llen", undefined>

type RedisSetMembersStage = RedisStageBuilder<"smembers", undefined>
type RedisSetIsMemberStage = RedisStageBuilder<"sismember", [member: string | number | Buffer]>
type RedisSetCardStage = RedisStageBuilder<"scard", undefined>
type RedisSetRandMemberStage = RedisStageBuilder<"srandmember", undefined | [count: string | number]>

type RedisZRangeStage = RedisStageBuilder<"zrange",
    | [...ScoreRange]
    | [...ScoreRange, ...WithScores]
    | [...ScoreRange, ...Limit]
    | [...ScoreRange, ...WithScores, ...Limit]>
type RedisZRevrangeStage = RedisStageBuilder<"zrevrange",
    | [...LimitRange]
    | [...LimitRange, ...WithScores]>
type RedisZRangebyscoreStage = RedisStageBuilder<"zrangebyscore",
    | [...ScoreRange]
    | [...ScoreRange, ...WithScores]
    | [...ScoreRange, ...Limit]
    | [...ScoreRange, ...WithScores, ...Limit]>
type RedisZRevrangebyscoreStage = RedisStageBuilder<"zrevrangebyscore",
    | [...ScoreRevRange]
    | [...ScoreRevRange, ...WithScores]
    | [...ScoreRevRange, ...Limit]
    | [...ScoreRevRange, ...WithScores, ...Limit]>;
type RedisZScoreStage = RedisStageBuilder<"zscore", [member: string | number | Buffer]>
type RedisZRankStage = RedisStageBuilder<"zrank", [member: string | number | Buffer]>
type RedisZRevrankStage = RedisStageBuilder<"zrevrank", [member: string | number | Buffer]>
type RedisZCardStage = RedisStageBuilder<"zcard", undefined>
type RedisZCountStage = RedisStageBuilder<"zcount", [...ScoreRange]>

type RedisExistsStage = RedisStageBuilder<"exists", undefined>
type RedisTypeStage = RedisStageBuilder<"type", undefined>
type RedisTtlStage = RedisStageBuilder<"ttl", undefined>
type RedisPTtlStage = RedisStageBuilder<"pttl", undefined>
type RedisBitcountStage = RedisStageBuilder<"bitcount",
    undefined
    | [...StartEndRange]
    | [...StartEndRange, byte: "BYTE"]
    | [...StartEndRange, bit: "BIT"]
>
type RedisGetBitStage = RedisStageBuilder<"getbit", [offset: string | number]>

type RedisXRangeStage = RedisStageBuilder<"xrange",
    | [...StartEndRange]
    | [...StartEndRange, countToken: "COUNT", count: string | number]
>
type RedisXRevrangeStage = RedisStageBuilder<"xrevrange",
    | [...StartEndRevRange]
    | [...StartEndRevRange, countToken: "COUNT", count: string | number]
>
export type RedisStage =
    | RedisGetStage
    | RedisGetBufferStage
    | RedisStringLenStage
    | RedisGetRangeStage
    | RedisHashGetStage
    | RedisHashGetAllStage
    | RedisHashMultiGetStage
    | RedisHashKeysStage
    | RedisHashValsStage
    | RedisHashLenStage
    | RedisHashExistsStage
    | RedisListIndexStage
    | RedisListRangeStage
    | RedisListLenStage
    | RedisSetMembersStage
    | RedisSetIsMemberStage
    | RedisSetCardStage
    | RedisSetRandMemberStage
    | RedisZRangeStage
    | RedisZRevrangeStage
    | RedisZRangebyscoreStage
    | RedisZRevrangebyscoreStage
    | RedisZScoreStage
    | RedisZRankStage
    | RedisZRevrankStage
    | RedisZCardStage
    | RedisZCountStage
    | RedisExistsStage
    | RedisTypeStage
    | RedisTtlStage
    | RedisPTtlStage
    | RedisBitcountStage
    | RedisGetBitStage
    | RedisXRangeStage
    | RedisXRevrangeStage


type RedisJsonStageBuilder<M extends RedisJsonAccessCommands, P> = {
    method: `json_${M}`,
    key: string,
    storeAs?: string
} & (P extends undefined ? {} : { path: P })

type RedisJsonGetStage = RedisJsonStageBuilder<"get", undefined>
type RedisJsonPickStage = RedisJsonStageBuilder<"pick", FieldPath>
type RedisJsonTypeStage = RedisJsonStageBuilder<"type", FieldPath | undefined>
type RedisJsonStrLenStage = RedisJsonStageBuilder<"strLen", FieldPath>
type RedisJsonObjLenStage = RedisJsonStageBuilder<"objLen", FieldPath | undefined>
type RedisJsonObjKeysStage = RedisJsonStageBuilder<"objKeys", FieldPath | undefined>

export type RedisJsonStage =
    | RedisJsonGetStage
    | RedisJsonPickStage
    | RedisJsonTypeStage
    | RedisJsonStrLenStage
    | RedisJsonObjLenStage
    | RedisJsonObjKeysStage