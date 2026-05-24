import { AnyRecord, IsArray, IsObject, NestedValueObject, PathIndex, PathTraverse, ReplaceValues } from "~/shared/types";
import Redis, { ChainableCommander } from "ioredis";
import { RedisJsonMutatorConfig, RedisJsonReturn } from "./engine";

export * from "~/shared/types"

type RedisOrPipeline = Redis | ChainableCommander;

// ------------ Type Transformer ------------------

type HandleLeaf<T, D, V, M extends Mode> = M extends "replace" ? V : M extends "mutate" ? V : T;

type HandleArray<T, D, V, M extends Mode> =
    T extends Array<infer U>
    ? M extends "filter_and_infer"
    ? PathIndexForMutation<T> | PathIndexForMutation<U> | PathTraverseForMutation<any>
    : M extends "replace" | "mutate"
    ? V | PathIndexForMutation<V> | PathTraverseForMutation<V>
    : (U | U[] | PathIndexForMutation<U>)
    : never;


type Mode = "filter_and_infer" | "filter" | "mutate" | "update";

type Transform<T, D, V, M extends Mode> = {
    [K in keyof T as
    M extends "filter" | "mutate" | "filter_and_infer"
    ? T[K] extends D ? K : HasTypeDeep<T[K], D> extends true ? K : never
    : K
    ]:
    IsObject<T[K]> extends true
    ? (
        // recursion
        Partial<Transform<T[K], D, V, M>>
        // optional control flags
        | V
        // path support (only where needed)
        | (
            M extends "update" | "mutate"
            ? PathTraverseForMutation<V>
            : never
        )
    )
    : IsArray<T[K]> extends true
    ? HandleArray<T[K], D, V, M>
    : HandleLeaf<T[K], D, V, M>;
};

// 1. Mutate by repacing everything with V
export type TypedNormalPathObject<T, V> =
    Transform<T, any, V, "mutate">;

// 2. Allow datatype
export type FilterDatatype<T, D> =
    Transform<T, D, never, "filter">;

// 3. Mutate given datatype
export type MutateGivenDatatype<T, D, V> =
    Transform<T, D, V, "mutate">;

// 4. Mutate same datatype
export type MutateSameDatatype<T, V> =
    Transform<T, V, V, "mutate">;

// 5. Update method path
export type UpdateMethodPath<T> =
    Transform<T, unknown, never, "update">;

export type ArrInsertPath<T> =
    Transform<T, Array<any>, never, "filter_and_infer">;




// ----- Overload Helpers -------

export type PathTraverseForMutation<V = unknown> = PathTraverse & { $value: V }
export type PathIndexForMutation<V = unknown> = PathIndex & { $value: V }


// ------------------- Mutator Helpers -----------------

type HasTypeDeep<T, V> =
    // direct match
    T extends V ? true

    // array case
    : T extends Array<infer U> ? HasTypeDeep<U, V>

    // object case
    : T extends object
    ? true extends {
        [K in keyof T]: HasTypeDeep<T[K], V>
    }[keyof T]
    ? true : false

    : false;

// Untyped object for mutation - Replaces value with the given value
export type UnTypedNormalPathObject<V> = {
    [key: string]: V | UnTypedNormalPathObject<V> | PathTraverseForMutation<V> | PathIndexForMutation<V>
}


// ------------------- Mutation Method Overloads -----------------------

export type GeneralMutationPathObject<T, V, O> = [T] extends [never] ? NestedValueObject<V> : O;
export type MutationPathObject<T, V> = GeneralMutationPathObject<T, V, Partial<ReplaceValues<T, V>>>;
export type StrictMutationPathObject<T, V> = GeneralMutationPathObject<T, V, MutateSameDatatype<T, V>>;
export type ReplaceableMutationPathObject<T, D, V> = GeneralMutationPathObject<T, V, MutateGivenDatatype<T, D, V>>;

export type NormalRedisJsonMutationMethods<R extends RedisOrPipeline, F> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<T>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<T>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, ReplaceValues<T, F>>;
};

export type MutationOverload<R extends RedisOrPipeline, F, D = unknown, V = unknown> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<MutateGivenDatatype<T, D, V>>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, T>;

    (
        key: string,
        value: UnTypedNormalPathObject<V>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, NestedValueObject<F>>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<MutateGivenDatatype<T, D, V>>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, ReplaceValues<T, F>>;

    (
        key: string,
        value: UnTypedNormalPathObject<V>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, NestedValueObject<F>>;
};

export type StrictRedisJsonMutationMethods<R extends RedisOrPipeline, V, F> = MutationOverload<R, F, V, V>

export type SetMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: T,
        option: { returns: "mutated document" } & Omit<RedisJsonMutatorConfig, "returns">
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: T,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, "OK">;
}

// json.merge

export type MergeMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<T>,
        option: { returns: "mutated document" } & Omit<RedisJsonMutatorConfig, "returns">
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<T>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, "OK">;
}

// json.update

export type UpdateMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<UpdateMethodPath<T>>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<UpdateMethodPath<T>>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, "OK">;

}

// json.patch

export type TypedPatchMethodPath<T = Record<string | number, unknown>> = {
    $set?: Partial<UpdateMethodPath<T>>,
    $merge?: Partial<T>,
    $array?: {
        $append?: Partial<PathForArrAppend<T>>;
        $insert?: Partial<TypedPathForArrInsert<T>>;
        $trim?: Partial<TypedPathForArrTrim<T>>;
        $pop?: Partial<TypedPathForArrPop<T>>;
    }
    $appendInString?: Partial<TypedPathForStrAppend<T>>;
    $number?: {
        $inc_by?: Partial<TypedPathForNumberMethods<T>>;
        $mul_by?: Partial<TypedPathForNumberMethods<T>>;
    }
    $toggle?: Partial<TypedPathForToggleMethod<T>>,
}

export type UnTypedPatchMethodPath<T = Record<string | number, unknown>> = {
    $set?: Partial<UpdateMethodPath<T>>,
    $merge?: Partial<T>,
    $array?: {
        $append?: Partial<PathForArrAppend<T>>;
        $insert?: Partial<UntypedPathForArrInsert>;
        $trim?: Partial<UntypedPathForArrTrim>;
        $pop?: Partial<UntypedPathForArrPop>;
    }
    $appendInString?: UntypedPathForStrAppend;
    $number?: {
        $inc_by?: UntypedPathForNumberMethods;
        $mul_by?: UntypedPathForNumberMethods;
    }
    $toggle?: Partial<UntypedPathForToggleMethod>,
}

export type PatchMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: TypedPatchMethodPath<T>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: TypedPatchMethodPath<T>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, "OK">;

    (
        key: string,
        value: UnTypedPatchMethodPath,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, AnyRecord>;

    (
        key: string,
        value: UnTypedPatchMethodPath,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, "OK">;
};

// json.del

export type DeleteMethodPath<T> = Partial<TypedNormalPathObject<T, true>>;

export type DeleteMethodOverload<R extends RedisOrPipeline> = {
    (
        key: string,
        value?: undefined,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, 1 | 0>;

    <T extends AnyRecord>(
        key: string,
        value: DeleteMethodPath<T>,
        option: { returns: "mutated document" | "non mutated document" } & RedisJsonMutatorConfig
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: DeleteMethodPath<T>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, ReplaceValues<T, 1>>;

}

// json.strAppend

export type TypedPathForStrAppend<T> = MutateSameDatatype<T, string>;
export type UntypedPathForStrAppend = UnTypedNormalPathObject<string>;
export type StrAppendMethodOverload<R extends RedisOrPipeline> = StrictRedisJsonMutationMethods<R, string, number>;

// json.numIncrBy & json.numMultBy

export type TypedPathForNumberMethods<T> = MutateGivenDatatype<T, number, number>;
export type UntypedPathForNumberMethods = UnTypedNormalPathObject<number>;
export type NumberMethodOverload<R extends RedisOrPipeline> = StrictRedisJsonMutationMethods<R, number, number>;

// json.arrAppend

export type PathForArrAppend<T> = FilterDatatype<T, Array<any>>;
export type ArrAppendMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<FilterDatatype<T, Array<any>>>,
        option: { returns: "mutated document" } & Omit<RedisJsonMutatorConfig, "returns">
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<FilterDatatype<T, Array<any>>>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, ReplaceValues<T, number>>;
};

// json.arrInsert

export type TypedPathForArrInsert<T> = ArrInsertPath<T>;
export type UntypedPathForArrInsert = UnTypedNormalPathObject<PathIndexForMutation<any> | PathTraverseForMutation<any>>;
export type ArrInsertMethodOverload<R extends RedisOrPipeline> = {
    <T extends AnyRecord>(
        key: string,
        value: Partial<ArrInsertPath<T>>,
        option: { returns: "mutated document" } & Omit<RedisJsonMutatorConfig, "returns">
    ): RedisJsonReturn<R, T>;

    <T extends AnyRecord>(
        key: string,
        value: Partial<ArrInsertPath<T>>,
        option?: RedisJsonMutatorConfig
    ): RedisJsonReturn<R, ReplaceValues<T, number>>;
};

// json.arrTrim

export type TypedPathForArrTrim<T> = MutateGivenDatatype<T, any[], [start: number, stop: number]>;
export type UntypedPathForArrTrim = UnTypedNormalPathObject<[start: number, stop: number]>;
export type ArrTrimMethodOverload<R extends RedisOrPipeline> = MutationOverload<R, number, any[], [start: number, stop: number]>;

// json.arrPop

export type TypedPathForArrPop<T> = MutateGivenDatatype<T, any[], true>;
export type UntypedPathForArrPop = UnTypedNormalPathObject<true>;
export type ArrPopMethodOverload<R extends RedisOrPipeline> = MutationOverload<R, unknown, any[], true>;

// json.toggle

export type TypedPathForToggleMethod<T> = MutateGivenDatatype<T, boolean, true>;
export type UntypedPathForToggleMethod = UnTypedNormalPathObject<true>;
export type ToggleMethodOverload<R extends RedisOrPipeline> = MutationOverload<R, boolean, boolean, true>;