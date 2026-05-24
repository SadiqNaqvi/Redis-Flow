import { exampleDocument } from "~/test/constant";
import { RedisJson } from "~/json/src/engine";
import { getRedis } from "~/shared/lib/redis";
import { expect, test, describe, beforeEach, afterEach } from "vitest";

describe("patch fields of a JSON document", async () => {

    const redis = await getRedis();
    const json = new RedisJson(redis);
    let key = '';

    beforeEach(async () => {
        key = `redisJsonTest:mutate:${crypto.randomUUID()}`

        await json.set(key, exampleDocument);
    });

    afterEach(async () => {
        await expect(json.del(key)).resolves.toBe(1);
        key = '';
    });

    test("should update fields", async () => {

        const value = await json.patch(
            key,
            {
                $set: {
                    name: "John Doe",
                    location: { city: "Some city updated" },
                    fav_games: { $index: 0, $value: "Updated" },
                    hobbies: { indoor: ["hobbies.indoor - Updated"] },
                }
            },
            { returns: "mutated document" }
        );

        const result = await json.get<typeof exampleDocument>(key);

        const expected = {
            name: "John Doe",
            fav_games: ["Updated", ...exampleDocument.fav_games.slice(1)],
            hobbies: {
                ...exampleDocument.hobbies,
                indoor: ["hobbies.indoor - Updated"],
            },
            location: {
                ...exampleDocument.location,
                city: "Some city updated"
            }
        }

        expect(result).toMatchObject(expected);
        expect(result).toStrictEqual(value);
        expect(result.name).toBe("John Doe");
        expect(result.location.city).toBe("Some city updated");
        expect(result.fav_games[0]).toBe("Updated");
        expect(result.hobbies.indoor).toStrictEqual(["hobbies.indoor - Updated"]);

    });

    test("should merge fields", async () => {
        const value = await json.patch(
            key,
            {
                $merge: {
                    some: { nested: "field" },
                    stringField: "string",
                    numberField: 0,
                    booleanField: true,
                    someArray: ["value"],
                }
            }
        );

        const result = await json.get(key);

        const expected = {
            stringField: "string",
            numberField: 0,
            booleanField: true,
            someArray: ["value"],
            some: { nested: "field" }
        }

        expect(result).toMatchObject(expected);
        expect(value).toStrictEqual("OK");
        expect(result.stringField).toStrictEqual("string");
        expect(result.numberField).toStrictEqual(0);
        expect(result.booleanField).toStrictEqual(true);
        expect(result.someArray).toStrictEqual(["value"]);
        expect(result.some).toStrictEqual({ nested: "field" });

    });

    test("should append string to nested string type fields", async () => {
        const value = await json.patch(
            key,
            {
                $appendInString: {
                    name: " Doe",
                    location: { city: " updated" },
                    fav_games: { $index: 0, $value: " Updated" },
                    hobbies: { indoor: { $index: 0, $value: " hobbies.indoor - Updated" } },
                }
            }
        );

        const result = await json.get<typeof exampleDocument>(key);

        expect(result).toMatchObject({
            name: "Jason Doe",
            fav_games: [exampleDocument.fav_games[0].concat(" Updated"), ...exampleDocument.fav_games.slice(1)],
            hobbies: {
                ...exampleDocument.hobbies,
                indoor: [
                    exampleDocument.hobbies.indoor[0].concat(" hobbies.indoor - Updated"),
                    ...exampleDocument.hobbies.indoor.slice(1),
                ],
            },
            location: {
                ...exampleDocument.location,
                city: exampleDocument.location.city.concat(" updated")
            }
        });

        expect(value).toStrictEqual("OK");
        expect(result.name).toBe("Jason Doe");
        expect(result.location.city).toBe(exampleDocument.location.city.concat(" updated"));
        expect(result.fav_games[0]).toBe(exampleDocument.fav_games[0].concat(" Updated"));
        expect(result.hobbies.indoor[0]).toBe(exampleDocument.hobbies.indoor[0].concat(" hobbies.indoor - Updated"));

    });

    test("should append to nested arrays", async () => {
        const value = await json.patch(
            key,
            {
                $array: {
                    $append: {
                        someField: { $index: 1, $value: [7] },
                        fav_games: ["Fortnite"],
                        hobbies: { indoor: ["Reading"] },
                    }
                }
            }
        );

        const result = await json.get(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            fav_games: exampleDocument.fav_games.concat("Fortnite"),
            someField: [[1, 2, 3], [4, 5, 6, 7]],
            hobbies: { indoor: exampleDocument.hobbies.indoor.concat("Reading") }
        });


    });

    test("should pop from nested arrays", async () => {
        const value = await json.patch(
            key,
            {
                $array: {
                    $pop: {
                        someField: { $index: 1, $value: true },
                        fav_games: true,
                        hobbies: { indoor: true },
                    }
                }
            }
        );

        const result = await json.get(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            fav_games: exampleDocument.fav_games.slice(0, -1),
            someField: [[1, 2, 3], [4, 5]],
            hobbies: { indoor: exampleDocument.hobbies.indoor.slice(0, -1) }
        });


    });

    test("should insert in nested arrays", async () => {
        const value = await json.patch(
            key,
            {
                $array: {
                    $insert: {
                        someField: { $path: [0, 1], $value: 10 },
                        fav_games: { $index: 0, $value: "Fortnite" },
                        hobbies: { indoor: { $index: 0, $value: "Sleeping" } },
                    }
                }
            }
        );

        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            fav_games: ["Fortnite", ...exampleDocument.fav_games],
            someField: [[1, 10, 2, 3], [4, 5, 6]],
            hobbies: { indoor: ["Sleeping", ...exampleDocument.hobbies.indoor] }
        });

        expect(result.fav_games[0]).toBe("Fortnite");
        expect(result.someField[0][1]).toBe(10);
        expect(result.hobbies.indoor[0]).toBe("Sleeping");


    });

    test("should trim nested arrays", async () => {
        const value = await json.patch(
            key,
            {
                $array: {
                    $trim: {
                        someField: { $index: 0, $value: [0, 2] }, // this would have no effect on someField[0] because it only have 3 elements, so 0-2 means keep 0,1,2.
                        fav_games: [0, 1],
                        hobbies: { indoor: [0, 4] }, // Same goes here because it only has 2 elements.
                    }
                }
            }
        );

        const result = await json.get<typeof exampleDocument>(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            fav_games: exampleDocument.fav_games.slice(0, 2),
            someField: exampleDocument.someField,
            hobbies: { indoor: exampleDocument.hobbies.indoor }
        });

        expect(result.fav_games.length).toBe(2);
        expect(result.someField[0].length).toBe(exampleDocument.someField[0].length);
        expect(result.hobbies.indoor.length).toBe(exampleDocument.hobbies.indoor.length);


    });

    test("should increase number fields", async () => {

        const key = `redisJsonTest:mutate:${crypto.randomUUID()}`

        const doc = { ...exampleDocument, someNestedNumberField: { children: 5 } }

        await json.set(key, doc);

        const value = await json.patch(
            key,
            {
                $number: {
                    $inc_by: {
                        age: 5,
                        someNestedNumberField: { children: 10 },
                        someField: { $path: [0, 0], $value: 1 },
                    }
                }
            }
        );

        const result = await json.get<typeof doc>(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            age: doc.age + 5,
            someField: [[doc.someField[0][0] + 1, ...doc.someField[0].slice(1)], ...doc.someField.slice(1)],
            someNestedNumberField: { children: doc.someNestedNumberField.children + 10 }
        });

        expect(result.age).toBe(doc.age + 5);
        expect(result.someNestedNumberField.children).toBe(doc.someNestedNumberField.children + 10);
        expect(result.someField[0][0]).toBe(doc.someField[0][0] + 1);


    });

    test("should multiply number fields", async () => {

        const key = `redisJsonTest:mutate:${crypto.randomUUID()}`

        const doc = { ...exampleDocument, someNestedNumberField: { children: 5 } }

        await json.set(key, doc);

        const value = await json.patch(
            key,
            {
                $number: {
                    $mul_by: {
                        age: 5,
                        someNestedNumberField: { children: 10 },
                        someField: { $path: [0, 0], $value: 2 },
                    }
                }
            }
        );

        const result = await json.get<typeof doc>(key);

        expect(value).toBe("OK");

        const updatedAge = doc.age * 5;
        const updatedNestedNumberField = doc.someNestedNumberField.children * 10;

        expect(result).toMatchObject({
            age: updatedAge,
            someField: [[doc.someField[0][0] * 2, ...doc.someField[0].slice(1)], ...doc.someField.slice(1)],
            someNestedNumberField: { children: updatedNestedNumberField }
        });

        expect(result.age).toBe(updatedAge);
        expect(result.someNestedNumberField.children).toBe(updatedNestedNumberField);
        expect(result.someField[0][0]).toBe(doc.someField[0][0] * 2);


    });

    test("should toggle boolean fields", async () => {

        const key = `redisJsonTest:mutate:${crypto.randomUUID()}`

        const doc = { ...exampleDocument, someNestedBooleanField: { children: false } }

        await json.set(key, doc);

        const value = await json.patch<typeof doc>(
            key,
            {
                $toggle: {
                    someNestedBooleanField: { children: true },
                    isAdult: true,
                }
            }
        );

        const result = await json.get<typeof doc>(key);

        expect(value).toBe("OK");

        expect(result).toMatchObject({
            isAdult: !doc.isAdult,
            someNestedBooleanField: { children: !doc.someNestedBooleanField.children }
        });

        expect(result.isAdult).toBe(!doc.isAdult);
        expect(result.someNestedBooleanField.children).toBe(!doc.someNestedBooleanField.children);


    });

    test("patch multiple fields in one go", async () => {

        const key = `redisJsonTest:mutate:${crypto.randomUUID()}`

        const doc = exampleDocument;

        await json.set(key, doc);

        const value = await json.patch(
            key,
            {
                $set: {
                    name: "John", // name becomes John
                },
                $appendInString: {
                    name: " Doe", // " Doe" is added to name so now name becomes "John Doe"
                    location: { city: " updated" }
                },
                $toggle: {
                    isAdult: true,
                },
                $number: {
                    $inc_by: { age: 5 }, // age becomes 30
                    $mul_by: { age: 2 }, // age becomes 60
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
                        fav_games: true, // fortnite is already added in fav_games now the last member is popped.
                    }
                }
            }
        );

        const result = await json.get<typeof doc>(key);

        expect(value).toBe("OK");

        expect(result.name).toBe("John Doe");
        expect(result.location.city).toBe(doc.location.city.concat(" updated"));
        expect(result.isAdult).toBe(!doc.isAdult);
        expect(result.age).toBe(60);
        expect(result.hobbies.indoor).toStrictEqual(doc.hobbies.indoor.concat("Reading"));
        expect(result.hobbies.outdoor).toStrictEqual(doc.hobbies.outdoor.concat(["Skateboaring", "Basketball"]));
        expect(result.fav_games).toStrictEqual(["Fortnite", ...doc.fav_games.slice(0, -1)]);
        expect(result.someField[1]).toStrictEqual(doc.someField[1].slice(0, 2));


    });

});