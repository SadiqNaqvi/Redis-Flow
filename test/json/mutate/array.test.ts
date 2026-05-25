import { exampleDocument } from "../../constant";
import RedisJson from "~/json/src";
import { getRedis } from "../../utils";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const redis = await getRedis();
const json = new RedisJson(redis);

let key = '';
const doc = {
    fav_games: exampleDocument.fav_games,
    hobbies: exampleDocument.hobbies,
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

// --------- Append in Array ------------------
describe("should append elements in nested array fields", async () => {

    test("should append elements in array", async () => {

        const value = await json.arrAppend<typeof exampleDocument>(key, {
            fav_games: ["Fortnite"],
            hobbies: {
                indoor: "Reading",
                outdoor: ["Skateboading", "Swimming"],
            },
            someField: { $index: 1, $value: [7] }
        });


        const result = await json.get<typeof exampleDocument>(key);

        const updatedFavGames = exampleDocument.fav_games.concat("Fortnite");
        const updatedHobbiesIndoor = exampleDocument.hobbies.indoor.concat("Reading");
        const updatedHobbiesOutdoor = exampleDocument.hobbies.outdoor.concat(["Skateboading", "Swimming"]);
        const updatedSomeField = exampleDocument.someField[1].concat(7);

        expect(value).toStrictEqual({
            fav_games: updatedFavGames.length,
            hobbies: {
                indoor: updatedHobbiesIndoor.length,
                outdoor: updatedHobbiesOutdoor.length
            },
            someField: [updatedSomeField.length]
        });

        expect(result).toMatchObject({
            someField: [[1, 2, 3], [4, 5, 6, 7]],
            fav_games: updatedFavGames,
            hobbies: {
                indoor: updatedHobbiesIndoor,
                outdoor: updatedHobbiesOutdoor,
            }
        });
    });

    test("should throw error on appending element in a non-existing field", async () => {

        await expect(
            json.arrAppend(key, {
                hobbies: {
                    indoor: "Reading",
                    outdoor: ["Skateboading", "Swimming"],
                },
                someField: { $index: 1, $value: [7] },
                extraField: ["Fortnite"],
            })
        ).rejects.toThrow();


        const result = await json.get(key);


        expect(result).toStrictEqual(doc);
    });
})


// --------- Insert in Array ------------------

describe("should insert elements in nested array fields", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);

    test("should insert elements in array", async () => {

        const value = await json.arrInsert<typeof exampleDocument>(key, {
            fav_games: { $index: 1, $value: "Fortnite" },
            someField: { $path: [0, 2], $value: 5 },
            hobbies: {
                indoor: { $index: 1, $value: "Sleeping" },
                outdoor: { $index: 1, $value: "Touching Grass" }
            }
        });

        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toStrictEqual({
            fav_games: [exampleDocument.fav_games.length + 1],
            hobbies: {
                indoor: [exampleDocument.hobbies.indoor.length + 1],
                outdoor: [exampleDocument.hobbies.outdoor.length + 1]
            },
            someField: [[exampleDocument.someField[0].length + 1]]
        });

        expect(result.fav_games[1]).toBe("Fortnite");
        expect(result.someField[0][2]).toBe(5);
        expect(result.hobbies.indoor[1]).toBe("Sleeping");
        expect(result.hobbies.outdoor[1]).toBe("Touching Grass");

    });

    test("should throw error on inserting element in a non-existing field", async () => {

        await expect(
            json.arrInsert(key, {
                fav_games: { $index: 1, $value: "Fortnite" },
                someField: { $path: [0, 2], $value: 5 },
                extraField: { $index: 0, $value: "Fortnite" },
            })
        ).rejects.toThrow();


        const result = await json.get(key);

        // Should stay unmutated
        expect(result).toStrictEqual(doc);
    });

});


// --------- Pop in Array ------------------

describe("should pop element from nested array fields", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);

    test("should pop element in array", async () => {


        const value = await json.arrPop(key, {
            fav_games: true,
            someField: { $index: 0, $value: true },
            hobbies: {
                indoor: true,
            }
        });


        const result = await json.get<typeof exampleDocument>(key);

        const updatedFavGames = exampleDocument.fav_games.slice(0, -1);
        const updatedHobbiesIndoor = exampleDocument.hobbies.indoor.slice(0, -1);
        const updatedSomeField = exampleDocument.someField[0].slice(0, -1);

        expect(value).toStrictEqual({
            fav_games: exampleDocument.fav_games[exampleDocument.fav_games.length - 1],
            hobbies: {
                indoor: exampleDocument.hobbies.indoor[exampleDocument.hobbies.indoor.length - 1],
            },
            someField: [exampleDocument.someField[0][exampleDocument.someField[0].length - 1]]
        });

        expect(result).toMatchObject({
            fav_games: updatedFavGames,
            hobbies: {
                indoor: updatedHobbiesIndoor,
            },
            someField: [updatedSomeField, exampleDocument.someField[1]]
        });

    });

    test("should throw error on popping element from a non-existing field", async () => {

        await expect(
            json.arrPop(key, {
                fav_games: true,
                someField: { $index: 0, $value: true },
                extraField: true,
            })
        ).rejects.toThrow();

        const result = await json.get(key);

        // Should stay un-mutated.
        expect(result).toStrictEqual(doc);
    });
});

// --------- Trim in Array ------------------

describe("should trim nested array", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);

    test("should trim array", async () => {

        const value = await json.arrTrim(key, {
            fav_games: [0, 1],
            someField: { $index: 0, $value: [0, 1] },
            hobbies: {
                indoor: [0, 1],
            }
        });


        const result = await json.get<typeof exampleDocument>(key);

        const updatedFavGames = exampleDocument.fav_games.slice(0, 2);
        const updatedHobbiesIndoor = exampleDocument.hobbies.indoor.slice(0, 2);
        const updatedSomeField = exampleDocument.someField[0].slice(0, 2);

        expect(value).toStrictEqual({
            fav_games: updatedFavGames.length,
            hobbies: {
                indoor: updatedHobbiesIndoor.length,
            },
            someField: [updatedSomeField.length]
        });

        expect(result).toMatchObject({
            fav_games: updatedFavGames,
            hobbies: {
                indoor: updatedHobbiesIndoor,
            },
            someField: [updatedSomeField, exampleDocument.someField[1]]
        });

    });

    test("should throw error on trimming a non-existing array field", async () => {

        await expect(
            json.arrTrim(key, {
                fav_games: [0, 1],
                someField: { $index: 0, $value: [0, 1] },
                extraField: [0, 1],
            })
        ).rejects.toThrow();

        const result = await json.get(key);

        // Should stay un-mutated.
        expect(result).toStrictEqual(doc);
    });
});