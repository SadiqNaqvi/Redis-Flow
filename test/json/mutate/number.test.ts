import { exampleDocument } from "../../constant";
import RedisJson from "~/json/src";
import { getRedis } from "../../utils";
import { afterEach, beforeEach, describe, expect, test } from "vitest";


const redis = await getRedis();
const json = new RedisJson(redis);
let key = '';

const doc = {
    age: exampleDocument.age,
    someField: exampleDocument.someField,
}

beforeEach(async () => {
    key = `redisJsonTest:mutate:${crypto.randomUUID()}`

    await json.set(key, doc);
});

afterEach(async () => {
    await expect(json.del(key)).resolves.toBe(1);
    key = '';
});

// --------- Increment in Number ------------------

describe("should increase number in nested fields", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);

    test("should increase number", async () => {

        const value = await json.numIncrBy<typeof exampleDocument>(key, {
            age: 5,
            someField: { $path: [0, 1], $value: 10 },
        });

        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toStrictEqual({
            age: exampleDocument.age + 5,
            someField: [[exampleDocument.someField[0][1] + 10]]
        });

        expect(result.age).toBe(exampleDocument.age + 5)
        expect(result.someField[0][1]).toBe(exampleDocument.someField[0][1] + 10)

    });

    test("should throw error on increasing a non-existing field", async () => {

        await expect(
            json.numIncrBy(key, {
                age: 5,
                someField: { $path: [0, 1], $value: 10 },
                extraField: 8,
            })
        ).rejects.toThrow();

        const result = await json.get(key);

        // Should stay un-mutated.
        expect(result).toStrictEqual(doc);
    });

});

// --------- Multiplication in Number ------------------

describe("should multiply number in nested fields", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);

    test("should multiply number", async () => {

        const value = await json.numMultBy<typeof exampleDocument>(key, {
            age: 5,
            someField: { $path: [0, 1], $value: 10 },
        });


        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toStrictEqual({
            age: exampleDocument.age * 5,
            someField: [[exampleDocument.someField[0][1] * 10]]
        });

        expect(result.age).toBe(exampleDocument.age * 5)
        expect(result.someField[0][1]).toBe(exampleDocument.someField[0][1] * 10)

    });

    test("should throw error on multiplying a non-existing field", async () => {

        await expect(
            json.numIncrBy(key, {
                age: 5,
                someField: { $path: [0, 1], $value: 10 },
                extraField: 8,
            })
        ).rejects.toThrow();

        const result = await json.get(key);

        // Should stay un-mutated.
        expect(result).toStrictEqual(doc);
    });

});