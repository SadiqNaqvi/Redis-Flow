import { exampleDocument } from "~/test/constant";
import { RedisJson } from "~/json/src/engine";
import { getRedis } from "~/shared/lib/redis";
import { afterEach, beforeEach, describe, expect, test } from "vitest";


const redis = await getRedis();
const json = new RedisJson(redis);
let key = '';

// --------- Set --------------

test("should set document", async () => {

    const key = `redisJsonTest:mutate:${crypto.randomUUID()}`

    const value = await json.set(key, exampleDocument, { returns: "mutated document" });

    const result = await json.get(key);

    await expect(json.del(key)).resolves.toBe(1);

    expect(value).toStrictEqual(exampleDocument);
    expect(value).toStrictEqual(result);
});

// --------- Toggle in Boolean ------------------

test("should toggle boolean fields of a JSON document", async () => {

    const key = `redisJsonTest:mutate:${crypto.randomUUID()}`;
    const doc = { isAdult: true, nested: { field: false } }
    await json.set(key, doc);

    const value = await json.toggle(key, {
        isAdult: true,
        nested: { field: true }
    });

    const result = await json.get<typeof doc>(key);

    await json.del(key);

    expect(value).toStrictEqual({
        isAdult: false,
        nested: { field: true }
    });

    expect(result.isAdult).toBe(false);

    expect(result.nested.field).toBe(true);

});



beforeEach(async () => {
    key = `redisJsonTest:mutate:${crypto.randomUUID()}`

    await json.set<Partial<typeof exampleDocument>>(key, exampleDocument);
});

afterEach(async () => {
    await json.del(key);
    key = '';
});



// --------- Update --------------

test("should update document", async () => {


    const value = await json.update(key, {
        name: "Joe Goldberg",
        fav_games: { $index: 0, $value: "updated game" },
        hobbies: {
            indoor: ["Reading", "Writing"],
            outdoor: { $index: 1, $value: "Skateboarding" }
        },
        someField: { $path: [0, 0], $value: 5 },
    });

    const result = await json.get<typeof exampleDocument>(key);

    expect(value).toStrictEqual({
        name: "OK",
        fav_games: ["OK"],
        hobbies: {
            indoor: "OK",
            outdoor: ["OK"]
        },
        someField: [["OK"]],
    });

    expect(result.name).toBe("Joe Goldberg");
    expect(result.fav_games[0]).toBe("updated game");
    expect(result.hobbies.outdoor[1]).toBe("Skateboarding");
    expect(result.hobbies.indoor).toStrictEqual(["Reading", "Writing"]);
    expect(result.someField[0][0]).toBe(5);

});


// --------- Merge --------------

test("should merge documents", async () => {


    const value = await json.merge(key, {
        some: { nested: "field" },
        stringField: "string",
        numberField: 0,
        booleanField: true,
        someArray: ["value"],
    });

    const result = await json.get(key);


    const expected = {
        stringField: "string",
        numberField: 0,
        booleanField: true,
        someArray: ["value"],
        some: { nested: "field" }
    }

    expect(result).toStrictEqual({ ...exampleDocument, ...expected });
    expect(value).toStrictEqual("OK");
    expect(result.stringField).toStrictEqual("string");
    expect(result.numberField).toStrictEqual(0);
    expect(result.booleanField).toStrictEqual(true);
    expect(result.someArray).toStrictEqual(["value"]);
    expect(result.some).toStrictEqual({ nested: "field" });

});


// --------- Delete --------------

describe("should delete fields or the whole document", async () => {


    test("should delete fields of a document", async () => {

        const value = await json.del<typeof exampleDocument>(key, {
            name: true,
            fav_games: { $index: 0, $value: true },
            hobbies: {
                indoor: true,
                outdoor: { $index: 1, $value: true }
            },
            someField: { $path: [0, 0], $value: true }
        });

        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toStrictEqual({
            name: 1,
            fav_games: [1],
            hobbies: {
                indoor: 1,
                outdoor: [1]
            },
            someField: [[1]]
        });

        expect(result.name).toBe(undefined);
        expect(result.fav_games[0]).toBe(exampleDocument.fav_games[1]);
        expect(result.hobbies.outdoor[1]).toBe(exampleDocument.hobbies.outdoor[2]);
        expect(result.hobbies.indoor).toBe(undefined);
        expect(result.someField[0][0]).toBe(exampleDocument.someField[0][1]);

    });

    test("should delete JSON document", async () => {

        const value1 = await json.del(key);
        const value2 = await json.del("randomKey");

        expect(value1).toBe(1);
        expect(value2).toBe(0);

    });
})


// --------- Append in String ------------------

describe("should append string", async () => {

    
    test("should append string into fields", async () => {

        const value = await json.strAppend(key, {
            name: " Parker",
            fav_games: { $index: 0, $value: "noWhiteSpace" },
            location: { country: " - Updated" },
            hobbies: { $path: ["indoor", 0], $value: " - game" }
        });

        const result = await json.get<typeof exampleDocument>(key);

        const updatedName = exampleDocument.name.concat(" Parker");
        const updatedFavGames = exampleDocument.fav_games[0].concat("noWhiteSpace");
        const updatedLocation = exampleDocument.location.country.concat(" - Updated");
        const updatedHobbies = exampleDocument.hobbies.indoor[0].concat(" - game");

        expect(value).toMatchObject({
            name: updatedName.length,
            fav_games: [updatedFavGames.length],
            location: { country: updatedLocation.length },
            hobbies: { indoor: [updatedHobbies.length] }
        });

        expect(result.name).toBe(updatedName);
        expect(result.fav_games[0]).toBe(updatedFavGames);
        expect(result.location.country).toBe(updatedLocation);
        expect(result.hobbies.indoor[0]).toBe(updatedHobbies);

    });

    test("should throw error when appending string into a non-string field", async () => {

        await expect(
            json.strAppend(key, {
                fav_games: { $index: 0, $value: "noWhiteSpace" },
                location: { country: " - Updated" },
                hobbies: { $path: ["indoor", 0], $value: " - game" },
                age: " Parker",
            })
        ).rejects.toThrow();

        const result = await json.get<typeof exampleDocument>(key);

        // Should stay non-mutated.
        expect(result).toStrictEqual(exampleDocument);

    });

});