import { handleIndexing, handleTraversing, normalizeArrays, parseKey, resolvedPathToLuaMutationStack, resolvePath, resolvePathForMutation, resolvePathForPatchMutation, setDeep, transformRedisResponse } from "~/json/src/tools";
import { describe, expect, test } from "vitest";

describe("should resolve Accessor and Mutator Path Object into redis supported stringified path value pair.", () => {

    test("should stringify path indexing for resolvePath function", () => {

        const fieldPath = {
            fav_games: { $index: 0 },
            hobbies: { $index: [0, 2] }
        }

        expect(
            handleIndexing(fieldPath.fav_games.$index, "fav_games", false)
        ).toStrictEqual(["fav_games[0]"])

        expect(
            handleIndexing(fieldPath.hobbies.$index, "hobbies", false)
        ).toStrictEqual(["hobbies[0]", "hobbies[2]"])
    });

    test("should stringify path traversing for resolvePath function", () => {

        const fieldPath = {
            fav_games: { $path: [0, 2] },
            hobbies: {
                $path: [
                    ["indoor", 2],
                    ["outdoor", 0],

                ]
            }
        }

        expect(
            handleTraversing(fieldPath.fav_games.$path, "fav_games", false)
        ).toBe("[0][2]")

        expect(
            handleTraversing(fieldPath.hobbies.$path, "hobbies", false)
        ).toStrictEqual([".indoor[2]", ".outdoor[0]"])
    });

    test("should resolve path for accessor field path", () => {
        const resolved = resolvePath({
            name: true,
            fav_games: { $index: 0 },
            hobbies: {
                indoor: true,
                outdoor: { $index: 2 }
            },
            someField: { $path: [0, 0] }
        });

        expect(resolved).toStrictEqual([
            "name",
            "fav_games[0]",
            "hobbies.indoor",
            "hobbies.outdoor[2]",
            "someField[0][0]",
        ]);
    });

    test("should resolve path for mutation object", () => {
        const resolved = resolvePathForMutation({
            name: "Joe Goldberg",
            fav_games: { $index: 0, $value: "updated game" },
            hobbies: {
                indoor: ["Reading", "Writing"],
                outdoor: { $index: 2, $value: "Skateboarding" }
            },
            someField: { $path: [0, 0], $value: 5 }
        });

        expect(resolved).toMatchObject({
            name: "Joe Goldberg",
            "fav_games[0]": "updated game",
            "hobbies.indoor": ["Reading", "Writing"],
            "hobbies.outdoor[2]": "Skateboarding",
            "someField[0][0]": 5,
        });
    });

    test("should resolve path for patch mutation object", () => {
        const resolved = resolvePathForPatchMutation({
            $set: {
                name: "John"
            },
            $appendInString: {
                name: " Doe",
                location: { city: " updated" }
            },
            $toggle: {
                isAdult: true,
            },
            $number: {
                $inc_by: { age: 5 },
                $mul_by: { age: 2 },
            },
            $array: {
                $append: {
                    hobbies: {
                        indoor: "Reading",
                        outdoor: ["Skateboaring", "Basketball"]
                    }
                },
                $insert: {
                    fav_games: { $index: 0, $value: "Fortnite" }
                },
                $trim: {
                    someField: { $index: 1, $value: [0, 1] }
                },
                $pop: {
                    fav_games: { $index: 0, $value: true },
                }
            }
        });

        expect(resolved).toMatchObject({
            '$set': { name: 'John' },
            '$appendInString': { name: ' Doe', 'location.city': ' updated' },
            '$toggle': { isAdult: true },
            '$number': {
                '$inc_by': { age: 5 },
                '$mul_by': { age: 2 }
            },
            '$array': {
                '$append': {
                    'hobbies.indoor': 'Reading',
                    'hobbies.outdoor': ["Skateboaring", "Basketball"]
                },
                '$insert': { 'fav_games[0]': 'Fortnite' },
                '$trim': { 'someField[1]': [0, 1] },
                '$pop': { "fav_games[0]": true }
            }
        });
    });

    test("should conver resolved path to lua supported mutation stack", () => {
        const mutationStack = resolvedPathToLuaMutationStack({
            '$set': { name: 'John' },
            '$appendInString': { name: ' Doe', 'location.city': ' updated' },
            '$toggle': { isAdult: true },
            '$number': {
                '$inc_by': { age: 5 },
                '$mul_by': { age: 2 }
            },
            '$array': {
                '$append': {
                    'hobbies.indoor': 'Reading',
                    'hobbies.outdoor': ["Skateboaring", "Basketball"]
                },
                '$insert': { 'fav_games[0]': 'Fortnite' },
                '$trim': { 'someField[1]': [0, 1] },
                '$pop': { "fav_games[0]": true }
            }
        }, "patch");

        expect(mutationStack).toMatchObject([
            { op: 'set', path: '.name', value: 'John' },
            { op: 'strappend', path: '.name', value: ' Doe' },
            { op: 'strappend', path: '.location.city', value: ' updated' },
            { op: 'toggle', path: '.isAdult' },
            { op: 'numincrby', path: '.age', value: 5 },
            { op: 'nummultby', path: '.age', value: 2 },
            { op: 'arrappend', path: '.hobbies.indoor', values: ['Reading'] },
            {
                op: 'arrappend',
                path: '.hobbies.outdoor',
                values: ['Skateboaring', 'Basketball']
            },
            { op: 'arrinsert', path: '.fav_games', index: 0, values: ['Fortnite'] },
            { op: 'arrtrim', path: '.someField[1]', start: 0, stop: 1 },
            { op: 'arrpop', path: '.fav_games', index: 0 }
        ]);
    });
});

describe("should take redis response with stringified keys, transform and return parsed response", () => {

    const response = {
        name: "Joe Goldberg",
        "fav_games[0]": "updated game",
        "hobbies.indoor": ["Reading", "Writing"],
        "hobbies.outdoor[2]": "Skateboarding",
        "someField[0][0]": 5,
    }

    test("should parse stringified field key for redis response transformation", () => {
        expect(parseKey("name")).toStrictEqual(["name"]);
        expect(parseKey("fav_games[0]")).toStrictEqual(["fav_games", 0]);
        expect(parseKey("location.city")).toStrictEqual(["location", "city"]);
        expect(parseKey("hobbies.indoor[0]")).toStrictEqual(["hobbies", "indoor", 0]);
        expect(parseKey("someField[1][0]")).toStrictEqual(["someField", 1, 0]);
    });

    test("should set depth on response object using parsed key for redis response transformation", () => {

        const result = {};

        setDeep(result, parseKey("name"), response.name);
        expect(result).toMatchObject({ name: response.name });

        setDeep(result, parseKey("fav_games[0]"), response["fav_games[0]"]);
        expect(result).toMatchObject({ fav_games: [response["fav_games[0]"]] });

        setDeep(result, parseKey("hobbies.indoor"), response["hobbies.indoor"]);
        expect(result).toMatchObject({ hobbies: { indoor: response["hobbies.indoor"] } });

        const strictIndexedArray = [];
        strictIndexedArray[2] = response["hobbies.outdoor[2]"]; // this will look like [empty, empty, response_here]

        setDeep(result, parseKey("hobbies.outdoor[2]"), response["hobbies.outdoor[2]"]);
        expect(result).toMatchObject({ hobbies: { outdoor: strictIndexedArray } });

        setDeep(result, parseKey("someField[0][0]"), response["someField[0][0]"]);
        expect(result).toMatchObject({ someField: [[response["someField[0][0]"]]] });

        expect(result).toStrictEqual({
            name: response.name,
            fav_games: [response["fav_games[0]"]],
            hobbies: {
                indoor: response["hobbies.indoor"],
                outdoor: strictIndexedArray,
            },
            someField: [[response["someField[0][0]"]]]
        });

    });

    test("should compact arrays and remove empty elements for redis response transformation", () => {
        const strictIndexedArray = [];
        strictIndexedArray[2] = response["hobbies.outdoor[2]"]; // this will look like [empty, empty, response_here]

        const depthObj = {
            name: response.name,
            fav_games: [response["fav_games[0]"]],
            hobbies: {
                indoor: response["hobbies.indoor"],
                outdoor: strictIndexedArray,
            },
            someField: [[response["someField[0][0]"]]]
        }

        expect(normalizeArrays(depthObj)).toStrictEqual({
            ...depthObj,
            hobbies: {
                ...depthObj.hobbies,
                outdoor: strictIndexedArray.flat(),
            }
        });

    });

    test("should transform redis response with stringified keys into a parsed object", () => {

        expect(transformRedisResponse(response, false)).toStrictEqual({
            name: response.name,
            fav_games: [response["fav_games[0]"]],
            hobbies: {
                indoor: response["hobbies.indoor"],
                outdoor: [response["hobbies.outdoor[2]"]],
            },
            someField: [[response["someField[0][0]"]]]
        });

    });
});