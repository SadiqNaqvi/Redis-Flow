import Redis, { ChainableCommander } from "ioredis";
import { AnyRecord, IsArray, IsObject, PipelineResponseHandlerFunction, Primitive } from "~/shared/types/others";
import RedisJsonAccessor from "./engine";


// RedisJson Instance Type
type RedisOrPipeline = Redis | ChainableCommander;

// Script Type for Field Path Helper

export type NestedValueObject<V> = {
    [key: string]: V | Partial<NestedValueObject<V>>;
}

// Replace all values with the given value
export type ReplaceValues<T, V> = {
    [K in keyof T]: T[K] extends AnyRecord ? ReplaceValues<T[K], V> : V;
};

// Field Path for Accessor

export type PathTraverse = {
    $path: (string | number)[] | (string | number)[][];
};

export type PathIndex = {
    $index: number | number[];
};

type ObjectPath<T> = PathTraverse | true | {
    [K in keyof T]?: IsArray<T[K]> extends true ? ArrayPath : ObjectPath<T[K]>;
};

type ArrayPath = PathIndex | PathTraverse | true;

type MutateDataTypeForAccess<T, D, V> = {
    [K in keyof T as IsObject<T[K]> extends true ? K : T[K] extends D ? K : never]?
    : IsObject<T[K]> extends true
    ? Partial<MutateDataTypeForAccess<T[K], D, V>> | true | ObjectPath<T[K]>
    : T[K] extends Array<D>
    ? ArrayPath
    : V;
};

export type UntypedPathObject = {
    [K in string]: true | PathIndex | PathTraverse | UntypedPathObject;
};

export type TypedPathObject<T> = {
    [K in keyof T]?:
    T[K] extends Primitive
    ? true
    : IsArray<T[K]> extends true
    ? ArrayPath
    : ObjectPath<T[K]>;
};

/**
 * @example
 * ```ts
 * const obj = {
 *    name: "Jason",
    *    age: 25,
    *    location: {
    *      city: "Some city",
    *      state: "Some state",
    *      country: "Some country",
    *    },
    *    fav_games: ["GTA", "FIFA", "COD"],
    *    hobbies: {
    *      indoor: ["chess", "table tennis"],
    *      outdoor: ["volleyball", "tennis"],
    *    },
    *    someField: [[1,2,3], [4,5,6]]
    * }
    * ```
    * 
    * **Now to fetch a specific field:**
    * 
    * ```ts
    * 1. "name" or { name: true }
    * -> // for {name: "Jason"}
    * 
    * 2. "fav_games[0]" or { fav_games: { $index: 0 } }
    * -> // { fav_games: "GTA" }
    * 
    * 3. ["fav_games[0]", "fav_games[1]"] or { fav_games: { $index: [0, 1] } }
    * -> // { fav_games: ["GTA", "FIFA"] }
    * 
    * 4. "location.city" or { location: { city: true } }
    * -> // for { location: { city: "Some city" } }
    * 
    * 5. "hobbies.indoor[0]" or {hobbies: {$path: ["indoor", 0 ]}} or { hobbies: { indoor: { $index: 0 } } }
    * -> // for {hobbies: {indoor: "chess"}}
    * 
    * 6. "someField[0][2]" or {someField: {$path: [0, 2]}}
    * -> // for {someField: [[3]]}
    * 
    * 7. ["someField[0][2]", "someField[1][1]"] or {someField: {$path: [[0, 2], [1,1]]}}
    * -> // for {someField: [[3], [5]]}
    * 
    * ```
    * 
    * $index is for indexing.
    * $path is for traversing in depth of an array or object.
*/

export type FieldPath<T = TypedPathObject<unknown> | UntypedPathObject> = string | string[] | T;


// Accessor Overloads

export type AccessorOverload<R extends RedisOrPipeline, V> = {
    (key: string, path: string | string[] | UntypedPathObject, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, NestedValueObject<V>>;
    <T>(key: string, path: string | string[] | TypedPathObject<T>, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, T>;
};

export type AccessorOverloadIncludeRoot<R extends RedisOrPipeline, V> = {
    (key: string, path: string | string[] | UntypedPathObject, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, NestedValueObject<V>>;
    (key: string, path?: undefined): RedisJsonAccessorReturn<R, V>;
    <T>(key: string, path: string | string[] | TypedPathObject<T>, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, ReplaceValues<T, V>>;
};

export type StrictAccessorOverload<R extends RedisOrPipeline, D, V> = {
    (key: string, path: string | string[] | UntypedPathObject, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, NestedValueObject<V>>;
    <T>(key: string, path: string | string[]): RedisJsonAccessorReturn<R, ReplaceValues<T, V>>;
    <T>(key: string, path: MutateDataTypeForAccess<T, D, true>, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, ReplaceValues<T, V>>;
};

export type StrictAccessorOverloadIncludeRoot<R extends RedisOrPipeline, D, V> = {
    (key: string, path: string | string[] | UntypedPathObject, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, NestedValueObject<V>>;
    <T>(key: string, path?: undefined): RedisJsonAccessorReturn<R, V>;
    <T>(key: string, path: MutateDataTypeForAccess<T, D, true>, config?: RedisJsonAccessorConfig): RedisJsonAccessorReturn<R, ReplaceValues<T, V>>;
};

// Redis Accessor Commands Map

export type ObjectMethodFieldPath<T, D, V> = [T] extends [never] ? NestedValueObject<V> : MutateDataTypeForAccess<T, D, V>;

export type RedisJsonAccessCommandsMap = {
    get: <T>(key: string) => T,
    pick: <T>(key: string, path: FieldPath) => T,
    type: AccessorOverload<RedisOrPipeline, string | null>,
    strLen: AccessorOverload<RedisOrPipeline, number>,
    objLen: <T>(key: string, path: string | string[] | ObjectMethodFieldPath<T, AnyRecord, true> | undefined) => RedisJsonAccessorReturn<RedisOrPipeline, T>,
    objKeys: <T>(key: string, path: string | string[] | ObjectMethodFieldPath<T, AnyRecord, true> | undefined) => RedisJsonAccessorReturn<RedisOrPipeline, T>,
}

export type RedisJsonAccessCommands = keyof RedisJsonAccessCommandsMap;


// RedisJson and RedisJsonAccessor config types.

export type RedisJsonConfig = {

    /**
     * Redis Json uses `redis.pipeline()` to reduce round trips (RTT).
     * 
     * By default, we use our own pipeline response handler. But you can pass a custom response handler.
     * It should be a function that handles pipeline response returned by redis.pipeline(). The response can be of type `[error: Error | null, response: unknown]` or `[response: unknown]` or unknown.
     */
    pipelineResponseHandler?: PipelineResponseHandlerFunction;

    debug?: boolean
}

export type RedisJsonAccessorConfig = {
    preserveArrayIndices?: boolean;
}


// RedisJson and RedisJsonAccessor return type.
export type RedisJsonAccessorReturn<R extends RedisOrPipeline, T> = R extends Redis ? Promise<T> : RedisJsonAccessor<R>;
