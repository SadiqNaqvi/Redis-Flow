
// --------------------- Type Helpers ----------------------

export type Tail<T extends any[]> = T extends [any, ...infer Rest] ? Rest : [];

export type MustBeArray<T> = T extends Array<any> ? T : T[];


// ----------------- Pipeline Type Helpers ---------------------

export type PipelineHandlerInput = [err: Error | null, res: unknown][] | null;

export type PipelineResponseHandlerFunction = (res: unknown) => unknown[];


// -------------------- Datatype Checks ----------------

export type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type IsArray<T> = T extends readonly unknown[] ? true : false;

export type IsObject<T> = T extends object ? T extends unknown[] ? false : true : false;

export type AnyRecord = Record<string, any>

export type UnknownRecord = Record<string, unknown>

/** A single segment in a parsed path - either a string key or a numeric index. @internal */
export type Segment = string | number;

export type JSONValue =
    | string
    | number
    | boolean
    | null
    | JSONObject
    | JSONArray;

export type JSONObject = {
    [key: string]: JSONValue;
}

export type JSONArray = Array<JSONValue>;


// ---------------- General Return Type --------------------

export type GeneralReturnType<T = unknown> = {
    success: false,
    error: Error,
} | {
    success: true,
    result: T,
}

export type HandlePipelineResponseType<T = unknown> = {
    success: false,
    errors: string[],
    result: T | null,
} | {
    success: true,
    result: T,
    errors: [],
}