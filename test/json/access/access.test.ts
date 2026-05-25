import { exampleDocument } from "../../constant";
import RedisJson from "~/json/src";
import { getRedis } from "../../utils";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const key = `redisJsonTest:access:${crypto.randomUUID()}`
const redis = await getRedis();
const json = new RedisJson(redis);

beforeAll(async () => {
    await json.set(key, exampleDocument);
});

afterAll(async () => {
    await redis.del(key);
})

//  ------------- Get ----------------

describe("should get a JSON document", async () => {

    test("should get a full JSON document", async () => {

        const value = await json.get("redisJsonTest:access");
        expect(value).toStrictEqual(exampleDocument);
    });

    test("should return null on wrong key", async () => {
        expect(await json.get("wrongKey")).toBe(null);
    });

});

//  ------------- Pick ----------------

describe("should get parts of a JSON document", async () => {

    test("should get parts using normal field path", async () => {

        const value = await json.pick<typeof exampleDocument>(key, {
            name: true,
            age: true,
            location: { city: true },
            fav_games: { $index: 0 },
            hobbies: {
                indoor: { $index: [0, 1, 1] },
                outdoor: true,
            },
            someField: { $path: [0, 2] }
        });

        expect(value).toStrictEqual({
            name: exampleDocument.name,
            age: exampleDocument.age,
            location: { city: exampleDocument.location.city },
            fav_games: [exampleDocument.fav_games[0]],
            hobbies: {
                indoor: ["chess", "table tennis"],
                outdoor: exampleDocument.hobbies.outdoor,
            },
            someField: [[exampleDocument.someField[0][2]]],
        });
    });

    test("should get parts using only $path as field path", async () => {

        const value = await json.pick<typeof exampleDocument>(key, {
            location: { $path: ["city"] },
            fav_games: { $path: [0] },
            hobbies: {
                $path: [["indoor", 1], ["outdoor", 1]]
            },
            someField: { $path: [[0, 2], [1, 1]] }
        });

        expect(value).toStrictEqual({
            location: { city: exampleDocument.location.city },
            fav_games: [exampleDocument.fav_games[0]],
            hobbies: {
                indoor: [exampleDocument.hobbies.indoor[1]],
                outdoor: [exampleDocument.hobbies.outdoor[1]],
            },
            someField: [[exampleDocument.someField[0][2]], [exampleDocument.someField[1][1]]],
        });
    });

    test("should get parts using array of string as field path", async () => {

        const value = await json.pick(key, [
            "name",
            "location.city",
            "fav_games[0]",
            "hobbies.indoor[1]",
            "hobbies.outdoor[1]",
            "someField[0][2]",
            "someField[1][1]",
        ]);

        expect(value).toStrictEqual({
            name: exampleDocument.name,
            location: { city: exampleDocument.location.city },
            fav_games: [exampleDocument.fav_games[0]],
            hobbies: {
                indoor: [exampleDocument.hobbies.indoor[1]],
                outdoor: [exampleDocument.hobbies.outdoor[1]],
            },
            someField: [[exampleDocument.someField[0][2]], [exampleDocument.someField[1][1]]],
        });
    });

    test("should throw error on picking non-existing field", async () => {

        await expect(
            json.pick(key, {
                name: true,
                location: { city: true },
                nonExistingField: true,
            })
        ).rejects.toThrow();

    });

});


//  ------------- Type ----------------

describe("should get type of fields or of a document", async () => {

    test("should get type of fields", async () => {
        const value = await json.type(key, {
            name: true,
            fav_games: true,
            location: { city: true, country: true },
            someField: true,
            hobbies: true,
        });

        expect(value).toStrictEqual({
            location: {
                city: "string",
                country: "string"
            },
            fav_games: "array",
            name: "string",
            someField: "array",
            hobbies: "object",
        });
    });

    test("should get type of document", async () => {

        const value = await json.type(key);

        expect(value).toBe("object");

    });

    test("should get null on non-existing key", async () => {

        expect(
            await json.type("nonExistingKey", { name: true, fav_games: true })
        ).toStrictEqual({ name: null, fav_games: null });

        expect(
            await json.type("nonExistingKey")
        ).toBe(null);
    });

});


//  ------------- String Length ----------------

describe("should get length of string type fields", async () => {

    test("should get length of string using normal path field", async () => {

        const value = await json.strLen(key, {
            name: true,
            location: { city: true },
            hobbies: {
                indoor: { $index: 0 }
            },
        });

        expect(value).toStrictEqual({
            location: {
                city: exampleDocument.location.city.length
            },
            name: exampleDocument.name.length,
            hobbies: {
                indoor: [exampleDocument.hobbies.indoor[0].length]
            },
        });

    });

    test("should get length of string using array of string as path field", async () => {
        const value = await json.strLen(key, "name");

        expect(value).toStrictEqual({ name: exampleDocument.name.length });
    });

    test("should throw error on non-string field", async () => {
        await expect(
            json.strLen(key, {
                name: true,
                age: true,
            })
        ).rejects.toThrow();
    });

    test("should return null values on wrong key", async () => {

        expect(
            await json.strLen("nonexistingkey", { name: true, location: true })
        ).toStrictEqual({ name: null, location: null });

    });

});


//  ------------- Object Keys ----------------

describe("should get keys of object type fields or a JSON document", async () => {

    test("should get keys of object type fields", async () => {

        const value = await json.objKeys(key, {
            location: true,
            hobbies: true,
        });

        expect(value).toStrictEqual({
            location: Object.keys(exampleDocument.location),
            hobbies: Object.keys(exampleDocument.hobbies),
        });

    });

    test("should get keys of a JSON document", async () => {
        const value = await json.objKeys(key);

        expect(value).toStrictEqual(Object.keys(exampleDocument));
    });

    test("should throw error on non-object field", async () => {
        await expect(
            json.objKeys(key, {
                location: true,
                age: true,
            })
        ).rejects.toThrow();
    });

});

//  ------------- Object Keys Length ----------------

describe("should get keys length of object type fields or of a JSON document", async () => {

    test("should get keys length of object type fields", async () => {

        const value = await json.objLen(key, {
            location: true,
            hobbies: true,
            nonExistingField: true
        });

        expect(value).toStrictEqual({
            location: Object.keys(exampleDocument.location).length,
            hobbies: Object.keys(exampleDocument.hobbies).length,
            nonExistingField: null,
        });

    });

    test("should get keys length of a JSON document", async () => {
        const value = await json.objLen(key);

        expect(value).toStrictEqual(Object.keys(exampleDocument).length);
    });

    test("should throw error on non-object field", async () => {
        await expect(
            json.objLen(key, {
                location: true,
                name: true,
            })
        ).rejects.toThrow();
    });

    test("should throw error on wrong key", async () => {

        await expect(
            json.objLen("wrongKey")
        ).rejects.toThrow(/ERR Path does not exist or not an object/i);

        expect(
            await json.objLen(
                "wrongKey",
                { location: true, age: true }
            )
            // ).rejects.toThrow(/ERR Path does not exist or not an object/i);
        ).toStrictEqual({ location: null, age: null });
    });

});
