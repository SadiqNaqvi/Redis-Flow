import { RedisAggregator } from "~/aggregator/src/engine";
import { getRedis } from "~/shared/lib/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CartItem, cleanupAfterTesting, ExpectedRoom, Order, prepareAggregationTesting, Product, Room, User } from "./utils";

const redis = await getRedis();
const aggregator = new RedisAggregator(redis);
const currentUser = "user_001";

beforeAll(async () => {
    await prepareAggregationTesting(redis);
});

afterAll(async () => {
    await cleanupAfterTesting(redis);
});

// EASY TESTS

describe("Easy - single fetch + commit", async () => {

    const redis = await getRedis();
    const aggregator = new RedisAggregator(redis);

    test("fetch a single JSON document (user profile)", async () => {
        const result = await aggregator.aggregate<User>([
            { method: "json_get", key: "user:user_002", storeAs: "user" },
            { method: "commit" },
            {
                method: "windup",
                value: (s) => s.get<User>("user"),
            },
        ]);

        expect(result).toStrictEqual({
            user_id: "user_002",
            username: "spider_monkey",
            email: "spider@monk.io",
            avatar_url: "/avatars/002.png",
        });
    });

    test("fetch all members of a set (room participants)", async () => {
        const result = await aggregator.aggregate<string[]>([
            { method: "redis_smembers", key: "room:room_001:participants", storeAs: "participants" },
            { method: "commit" },
            {
                method: "windup",
                value: (s) => {
                    const p = s.get<string[]>("participants")!;
                    return p.sort();          // sort for deterministic comparison
                },
            },
        ]);

        expect(result).toStrictEqual(["user_001", "user_002"]);
    });

    test("read a plain string key (unread notification count)", async () => {
        const result = await aggregator.aggregate<number>([
            { method: "redis_get", key: `unreadCount:${currentUser}`, storeAs: "count" },
            { method: "commit" },
            {
                method: "windup",
                value: (s) => Number(s.get<string>("count")),
            },
        ]);

        expect(result).toBe(3);
    });

    test("fetch a hash (user cart)", async () => {
        const result = await aggregator.aggregate<Record<string, string>>([
            { method: "redis_hgetall", key: `cart:${currentUser}`, storeAs: "cart" },
            { method: "commit" },
            {
                method: "windup",
                value: (s) => s.get<Record<string, string>>("cart"),
            },
        ]);

        expect(result).toStrictEqual({ prod_001: "2", prod_003: "1", prod_004: "3" });
    });

    test("fetch a list (recent orders - list range)", async () => {
        const result = await aggregator.aggregate<string[]>([
            { method: "redis_lrange", key: `orders:${currentUser}`, storeAs: "orderIds", args: [0, -1] },
            { method: "commit" },
            { method: "windup", value: (s) => s.get<string[]>("orderIds") },
        ]);

        expect(result).toStrictEqual(["order_001", "order_002", "order_003"]);
    });
});


// limit branches

describe("Medium - derive / transform / validate", async () => {

    test("derive: calculate cart item count from hash", async () => {
        const result = await aggregator.aggregate<number>([
            { method: "redis_hgetall", key: `cart:${currentUser}`, storeAs: "cart" },
            { method: "commit" },
            {
                method: "derive",
                vals: (s) => {
                    const cart = s.get<Record<string, string>>("cart") ?? {};
                    return {
                        totalItems: Object.values(cart).reduce((sum, qty) => sum + Number(qty), 0)
                    }
                },
            },
            { method: "windup", value: (s) => s.get<number>("totalItems") },
        ]);

        expect(result).toBe(6); // 2 + 1 + 3
    });

    test("derive: build a sorted room list from a ZREVRANGE", async () => {
        const result = await aggregator.aggregate<string[]>([
            {
                method: "redis_zrevrange",
                key: `roomList:${currentUser}`,
                storeAs: "roomList",
                args: [0, 2],
            },
            { method: "commit" },
            { method: "windup", value: (s) => s.get<string[]>("roomList") },
        ]);

        // Top 3 most-recent rooms
        expect(result).toStrictEqual(["room_001", "room_002", "room_003"]);
    });

    test("validate: passes when user has rooms", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_zrevrange", key: `roomList:${currentUser}`, storeAs: "roomList", args: [0, -1] },
                { method: "commit" },
                {
                    method: "validate",
                    ref: "roomList",
                    validate: (_store, roomList: string[]) => roomList.length > 0,
                    messageOnFailure: "No rooms found",
                },
                { method: "windup", value: (s) => s.get("roomList") },
            ])
        ).resolves.not.toThrow();
    });

    test("validate: throws with custom message when user has no rooms", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_zrevrange", key: "roomList:ghost_user", storeAs: "roomList", args: [0, -1] },
                { method: "commit" },
                {
                    method: "validate",
                    ref: "roomList",
                    validate: (_store, roomList: string[]) => !!(roomList && roomList.length),
                    messageOnFailure: "No rooms found",
                },
                { method: "windup", value: (s) => s.get("roomList") },
            ])
        ).rejects.toThrow("No rooms found");
    });

    test("transform: normalise product prices to integers (cents)", async () => {
        const result = await aggregator.aggregate<number>([
            { method: "json_get", key: "product:prod_001", storeAs: "product" },
            { method: "commit" },
            {
                method: "transform",
                key: "product",
                transform: (_, p: Product) => ({ ...p, price: Math.round(p.price * 100) }),
            },
            { method: "windup", value: (s) => (s.get<Product>("product"))!.price },
        ]);

        expect(result).toBe(7999); // $79.99 -> 7999 cents
    });

    test("fetch product and validate it is in stock", async () => {
        // prod_001 has stock: 25 - should resolve
        await expect(
            aggregator.aggregate([
                { method: "json_get", key: "product:prod_001", storeAs: "product" },
                { method: "commit" },
                {
                    method: "validate",
                    ref: "product",
                    validate: (_s, product: Product) => product.stock > 0,
                    messageOnFailure: "Product is out of stock",
                },
                { method: "windup", value: (s) => s.get("product") },
            ])
        ).resolves.toMatchObject({ product_id: "prod_001" });

        // prod_002 has stock: 0 - should throw
        await expect(
            aggregator.aggregate([
                { method: "json_get", key: "product:prod_002", storeAs: "product" },
                { method: "commit" },
                {
                    method: "validate",
                    ref: "product",
                    validate: (_s, product: Product) => product.stock > 0,
                    messageOnFailure: "Product is out of stock",
                },
                { method: "windup", value: (s) => s.get("product") },
            ])
        ).rejects.toThrow("Product is out of stock");
    });

    test("followers / following: derive mutual-follow set", async () => {
        const result = await aggregator.aggregate<string[]>([
            { method: "redis_smembers", key: `followers:user_001`, storeAs: "followers" },
            { method: "redis_smembers", key: `following:user_001`, storeAs: "following" },
            { method: "commit" },
            {
                method: "derive",
                vals: (s) => {
                    const followers = new Set(s.get<string[]>("followers"));
                    const following = s.get<string[]>("following") ?? [];
                    return {
                        mutuals: following.filter(u => followers.has(u))
                    }
                },
            },
            { method: "windup", value: (s) => s.get<string[]>("mutuals") },
        ]);

        expect(result).toStrictEqual(["user_003"]); // only user_003 follows back
    });
});

// ============================================================================
// HARD TESTS
// ============================================================================

describe("Hard - branching + multi-commit pipelines", () => {

    test("user's room list: top 10 with full room details and other participants metadata", async () => {

        const result = await aggregator.aggregate<ExpectedRoom[]>([
            // Getting the first 10 rooms from the roomList of a user
            {
                method: "redis_zrevrange",
                key: `roomList:${currentUser}`,
                storeAs: "roomList",
                args: [0, 10],
            },

            // Commiting to get the value in store.
            { method: "commit" },

            // Validating if there are any rooms in the room list
            {
                method: "validate",
                ref: "roomList",
                validate: (_, roomList: string[]) => {
                    return !!(roomList && roomList.length)
                },
                messageOnFailure: "Room list is empty"
            },

            // Getting room data for all 10 rooms
            {
                method: "branch",
                ref: "roomList",
                explore: (_, roomList: string[]) => roomList.map(r => ({
                    method: "json_get",
                    key: `room:${r}`,
                }))
            },

            // Getting the participants of all 10 rooms
            {
                method: "branch",
                ref: "roomList",
                explore: (_, roomList: string[]) => roomList.map(r => ({
                    method: "redis_smembers",
                    key: `room:${r}:participants`,
                    storeAs: `participantList_${r}`
                }))
            },

            // Commiting to get the value in store.
            { method: "commit" },

            // deriving a roomId to other-participant id dictonary.
            {
                method: "derive",
                vals: (s) => {
                    const roomList = s.get("roomList") as string[];
                    const roomIdToParticipantIdMap = roomList.reduce(
                        (dict, r) => {
                            const participantList = s.get(`participantList_${r}`) as string[];
                            const otherUserId = participantList.find(u => u !== currentUser);
                            if (!otherUserId) return dict;
                            else return { ...dict, [r]: otherUserId }
                        },
                        {} as Record<string, string>)

                    return { roomIdToParticipantIdMap }
                }
            },

            // Branching other participants user data.
            {
                method: "branch",
                ref: "roomList",
                explore: (s, roomList: string[]) => {
                    const roomIdToParticipantIdMap = s.get("roomIdToParticipantIdMap") as Record<string, string>;
                    return roomList.map(r => {
                        const otherUserId = roomIdToParticipantIdMap[r];
                        return {
                            method: "json_get",
                            key: `user:${otherUserId}`,
                        }
                    })
                }
            },

            // Commiting to get the value in store.
            { method: "commit" },

            // Winding up - getting the return value ready.
            {
                method: "windup",
                value: (s) => {
                    const roomList = s.get("roomList") as string[];
                    const roomIdToParticipantIdMap = s.get("roomIdToParticipantIdMap") as Record<string, string>;
                    return roomList.map(r => {
                        const room = s.get(`room:${r}`) as Room;
                        const user_id = roomIdToParticipantIdMap[r];
                        const user = s.get(`user:${user_id}`) as User;
                        return {
                            ...room,
                            name: user.username,
                            participant_id: user.user_id
                        };
                    })
                }
            }
        ]);

        expect(result).toStrictEqual([
            {
                "lastMessage": "Hey, are we still meeting today?",
                "lastMessageAt": "2026-05-05T09:15:00Z",
                "name": "spider_monkey",
                "participant_id": "user_002",
                "room_id": "room_001",
            },
            {
                "lastMessage": "I sent you the files.",
                "lastMessageAt": "2026-05-05T09:10:00Z",
                "name": "king_tiger",
                "participant_id": "user_003",
                "room_id": "room_002",
            },
            {
                "lastMessage": "Let's catch up tomorrow!",
                "lastMessageAt": "2026-05-05T08:50:00Z",
                "name": "pink_dolphin",
                "participant_id": "user_004",
                "room_id": "room_003",
            },
            {
                "lastMessage": "Game night tonight?",
                "lastMessageAt": "2026-05-05T08:45:00Z",
                "name": "sweet_shark",
                "participant_id": "user_005",
                "room_id": "room_004",
            },
            {
                "lastMessage": "I'll call you in a bit.",
                "lastMessageAt": "2026-05-05T07:30:00Z",
                "name": "pink_dolphin",
                "participant_id": "user_004",
                "room_id": "room_005",
            },
        ]);
    });

    test("leaderboard: top-5 with full user profiles and rank numbers", async () => {
        type RankedUser = User & { score: number; rank: number };

        const result = await aggregator.aggregate<RankedUser[]>([
            // 1. Fetch top 5 player IDs with scores
            {
                method: "redis_zrevrangebyscore",
                key: "leaderboard:global",
                storeAs: "topIds",
                args: ["+inf", "-inf", "WITHSCORES", "LIMIT", 0, 5],
            },
            { method: "commit" },

            // 2. Parse the flat [id, score, id, score …] array into a map
            {
                method: "derive",
                vals: (s) => {
                    const flat = s.get<string[]>("topIds") ?? [];
                    const map: Record<string, number> = {};
                    for (let i = 0; i < flat.length; i += 2) {
                        map[flat[i]] = Number(flat[i + 1]);
                    }
                    return { scoreMap: map };
                },
            },
            {
                method: "derive",
                vals: (s) => ({
                    rankedIds: Object.keys(s.get<Record<string, number>>("scoreMap")!)
                }),
            },

            // 3. Branch: fetch each user's JSON doc
            {
                method: "branch",
                ref: "rankedIds",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({ method: "json_get", key: `user:${id}` })),
            },
            { method: "commit" },

            // 4. Assemble final ranked list
            {
                method: "windup",
                value: (s) => {
                    const scoreMap = s.get<Record<string, number>>("scoreMap")!;
                    return Object.keys(scoreMap)
                        .map((id, idx) => ({
                            ...s.get<User>(`user:${id}`)!,
                            score: scoreMap[id],
                            rank: idx + 1,
                        }));
                },
            },
        ]);

        expect(result).toHaveLength(5);
        expect(result![0]).toMatchObject({ user_id: "user_003", username: "king_tiger", score: 9850, rank: 1 });
        expect(result![4]).toMatchObject({ user_id: "user_001", username: "dark_wolf", score: 5400, rank: 5 });
    });

    test("shopping cart checkout: fetch cart, enrich with products, compute total", async () => {
        type EnrichedCartItem = CartItem & { name: string; unit_price: number; line_total: number };
        type CheckoutSummary = { items: EnrichedCartItem[]; total: number; currency: string };

        const result = await aggregator.aggregate<CheckoutSummary>([
            // 1. Fetch cart hash
            { method: "redis_hgetall", key: `cart:${currentUser}`, storeAs: "cart" },
            { method: "commit" },

            // 2. Derive ordered list of product IDs from cart
            {
                method: "derive",
                vals: (s) => ({
                    cartProductIds: Object.keys(s.get<Record<string, string>>("cart") ?? {})
                }),
            },

            // 3. Validate cart is not empty
            {
                method: "validate",
                ref: "cartProductIds",
                validate: (_s, ids: string[]) => ids.length > 0,
                messageOnFailure: "Cart is empty",
            },

            // 4. Branch: fetch each product's JSON doc
            {
                method: "branch",
                ref: "cartProductIds",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({ method: "json_get", key: `product:${id}` })),
            },
            { method: "commit" },

            // 5. Validate all fetched products are in stock
            {
                method: "validate",
                ref: "cartProductIds",
                validate: (s, ids: string[]) =>
                    ids.every(id => (s.get<Product>(`product:${id}`)?.stock ?? 0) > 0),
                messageOnFailure: "One or more items are out of stock",
            },

            // 6. Windup: build checkout summary
            {
                method: "windup",
                value: (s) => {
                    const cart = s.get<Record<string, string>>("cart")!;
                    const ids = s.get<string[]>("cartProductIds")!;
                    const items: EnrichedCartItem[] = ids.map(id => {
                        const product = s.get<Product>(`product:${id}`)!;
                        const quantity = Number(cart[id]);
                        return {
                            product_id: id,
                            quantity,
                            name: product.name,
                            unit_price: product.price,
                            line_total: +(product.price * quantity).toFixed(2),
                        };
                    });
                    const total = +items.reduce((sum, i) => sum + i.line_total, 0).toFixed(2);
                    return { items, total, currency: "USD" };
                },
            },
        ]);

        expect(result).toMatchObject({
            currency: "USD",
            total: expect.any(Number),
        });
        expect(result!.total).toBeCloseTo(79.99 * 2 + 34.99 + 8.99 * 3, 1);
        expect(result!.items).toHaveLength(3);
        expect(result!.items[0]).toMatchObject({
            product_id: "prod_001",
            quantity: 2,
            name: "Wireless Headphones",
            line_total: 159.98,
        });
    });

    test("order history: fetch orders, enrich each order's items with product data", async () => {
        type EnrichedOrder = Omit<Order, "items"> & {
            items: (CartItem & { name: string; price: number })[];
        };

        const result = await aggregator.aggregate<EnrichedOrder[]>([
            // 1. Get order IDs for current user
            { method: "redis_lrange", key: `orders:${currentUser}`, storeAs: "orderIds", args: [0, -1] },
            { method: "commit" },

            // 2. Fetch order documents
            {
                method: "branch",
                ref: "orderIds",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({ method: "json_get", key: `order:${id}` })),
            },
            { method: "commit" },

            // 3. Derive flat unique product IDs across all orders
            {
                method: "derive",
                vals: (s) => {
                    const ids = s.get<string[]>("orderIds")!;
                    const productSet = new Set<string>();
                    for (const id of ids) {
                        const order = s.get<Order>(`order:${id}`)!;
                        for (const item of order.items) productSet.add(item.product_id);
                    }
                    return { allProductIds: Array.from(productSet) };
                },
            },

            // 4. Fetch all referenced products in one commit
            {
                method: "branch",
                ref: "allProductIds",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({ method: "json_get", key: `product:${id}` })),
            },
            { method: "commit" },

            // 5. Assemble enriched orders
            {
                method: "windup",
                value: (s) => {
                    const orderIds = s.get<string[]>("orderIds")!;
                    return orderIds.map(id => {
                        const order = s.get<Order>(`order:${id}`)!;
                        return {
                            ...order,
                            items: order.items.map(item => {
                                const product = s.get<Product>(`product:${item.product_id}`)!;
                                return { ...item, name: product.name, price: product.price };
                            }),
                        };
                    });
                },
            },
        ]);

        expect(result).toHaveLength(3);
        expect(result![0]).toMatchObject({
            order_id: "order_001",
            status: "delivered",
            items: [{ product_id: "prod_001", quantity: 1, name: "Wireless Headphones" }],
        });
    });

    test("social feed: follower list -> their latest rooms -> room previews", async () => {
        // Simplified social inbox: show the most recent room for each person
        // that current user follows.

        const result = await aggregator.aggregate<{ username: string; latestRoom: Room | null }[]>([
            // 1. Whom does currentUser follow?
            { method: "redis_smembers", key: `following:${currentUser}`, storeAs: "following" },
            { method: "commit" },

            // 2. Fetch each followed user's profile
            {
                method: "branch",
                ref: "following",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({ method: "json_get", key: `user:${id}` })),
            },
            // 3. Also fetch each followed user's most-recent room ID
            {
                method: "branch",
                ref: "following",
                explore: (_s, ids: string[]) =>
                    ids.map(id => ({
                        method: "redis_zrevrange",
                        key: `roomList:${id}`,
                        storeAs: `recentRoom_${id}`,
                        args: [0, -1],
                    })),
            },
            { method: "commit" },

            // 4. Derive per-user latest roomId
            {
                method: "derive",
                vals: (s) => {
                    const ids = s.get<string[]>("following")!;
                    return {
                        followingLatestRoomIds: ids.map(id => {
                            const rooms = s.get<string[]>(`recentRoom_${id}`) ?? [];
                            return rooms[0] ?? null;
                        }).filter(Boolean)
                    };
                },
            },

            // 5. Fetch room docs (filter out nulls)
            {
                method: "branch",
                ref: "followingLatestRoomIds",
                explore: (s, _ids: string[]) => {
                    return _ids
                        .map(r => ({ method: "json_get", key: `room:${r}` }));
                },
            },
            // allowEmptyBatch: true because following users may or may not have rooms.
            { method: "commit", allowEmptyBatch: true },

            // 6. Build result
            {
                method: "windup",
                value: (s) => {
                    const ids = s.get<string[]>("following");
                    const roomIds = s.get<(string | null)[]>("followingLatestRoomIds");
                    return ids.map((id, idx) => {
                        const user = s.get<User>(`user:${id}`)!;
                        const roomId = roomIds[idx];
                        const room = roomId ? s.get<Room>(`room:${roomId}`) ?? null : null;
                        return { username: user.username, latestRoom: room };
                    });
                },
            },
        ]);

        expect(result).toHaveLength(2); // user_001 follows user_003 and user_005
        expect(result.find(r => r.username === "king_tiger")).toBeDefined();
        expect(result.find(r => r.username === "sweet_shark")).toBeDefined();
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe("Edge cases", () => {

    test("returns null from windup when store value is missing", async () => {
        const result = await aggregator.aggregate<string | null>([
            { method: "redis_get", key: "does:not:exist", storeAs: "missing" },
            { method: "commit" },
            { method: "windup", value: (s) => s.get<string>("missing") ?? null },
        ]);

        expect(result).toBeNull();
    });

    test("branch with empty explore result produces no additional redis calls", async () => {
        // roomList for a brand-new user is empty - branch should produce empty results gracefully
        const result = await aggregator.aggregate<string[]>([
            {
                method: "redis_zrevrange",
                key: "roomList:new_user",
                storeAs: "roomList",
                args: [0, -1],
            },
            { method: "commit" },
            {
                method: "branch",
                ref: "roomList",
                explore: (_s, roomList: string[]) =>
                    roomList.map(r => ({ method: "json_get", key: `room:${r}` })),
            },
            { method: "commit", allowEmptyBatch: true },
            { method: "windup", value: (s) => s.get<string[]>("roomList") ?? [] },
        ]);

        expect(result).toStrictEqual([]);
    });

    test("aggregateSafe returns null instead of throwing", async () => {
        const result = await aggregator.aggregateSafe<unknown>([
            { method: "redis_get", key: "some:key", storeAs: "val" },
            { method: "commit" },
            {
                method: "validate",
                ref: "val",
                validate: () => false,
                messageOnFailure: "Always fails",
            },
            { method: "windup", value: (s) => s.get("val") },
        ]);

        expect(result).toEqual({
            error: expect.objectContaining({
                message: "Validation failed: Always fails",
            }),
            success: false,
        })

        expect((result as { success: false, error: Error }).error).toBeInstanceOf(Error);
    });

    test("multiple derives in sequence accumulate correctly in store", async () => {
        const result = await aggregator.aggregate<number>([
            { method: "redis_hgetall", key: `cart:${currentUser}`, storeAs: "cart" },
            { method: "commit" },
            {
                method: "derive",
                vals: (s) => {
                    const cart = s.get<Record<string, string>>("cart") ?? {};
                    return { itemCount: Object.values(cart).reduce((n, q) => n + Number(q), 0) };
                },
            },
            {
                method: "derive",
                vals: (s) => ({ itemCountDoubled: (s.get<number>("itemCount") ?? 0) * 2 }),
            },
            { method: "windup", value: (s) => s.get<number>("itemCountDoubled") },
        ]);

        expect(result).toBe(12); // (2+1+3) * 2
    });

    test("AbortSignal aborts mid-pipeline", async () => {
        const controller = new AbortController();
        // Abort immediately
        controller.abort(new Error("User cancelled"));

        await expect(
            aggregator.aggregate(
                [
                    { method: "redis_get", key: `unreadCount:${currentUser}`, storeAs: "count" },
                    { method: "commit" },
                    { method: "windup", value: (s) => s.get("count") },
                ],
                { signal: controller.signal }
            )
        ).rejects.toThrow("User cancelled");
    });

    test("timeout fires when aggregation exceeds timeoutInSeconds", async () => {
        const slowAggregator = new RedisAggregator(redis, { timeoutInSeconds: 0.01 });

        await expect(
            slowAggregator.aggregate([
                { method: "redis_get", key: `unreadCount:${currentUser}`, storeAs: "count" },
                { method: "commit" },
                {
                    method: "derive",
                    vals: () => ({
                        slow: new Promise(resolve => setTimeout(() => resolve(42), 500))
                    }),
                },
                { method: "windup", value: (s) => s.get("slow") },
            ])
        ).rejects.toThrow(/timeout/i);
    });

    test("transform can overwrite a value in the store", async () => {
        const result = await aggregator.aggregate<string>([
            { method: "json_get", key: "user:user_001", storeAs: "user" },
            { method: "commit" },
            {
                method: "transform",
                key: "user",
                transform: (s) => {
                    const u = s.get<User>("user")!;
                    return { ...u, username: u.username.toUpperCase() };
                },
            },
            { method: "windup", value: (s) => (s.get<User>("user"))!.username },
        ]);

        expect(result).toBe("DARK_WOLF");
    });
});

// ============================================================================
// ERROR HANDLING - validateStages & runtime guards
// ============================================================================

describe("Error handling - invalid stage configurations", () => {

    test("throws when stages array is empty", async () => {
        await expect(aggregator.aggregate([] as any)).rejects.toThrow(
            /Empty stages/i
        );
    });

    test("throws when first stage is not a redis or redis-json stage", async () => {
        await expect(
            aggregator.aggregate([
                {
                    method: "validate",
                    validate: () => true,
                },
                { method: "commit" },
                { method: "windup", value: () => null },
            ] as any)
        ).rejects.toThrow(/First stage must be either redis or redis-json/i);
    });

    test("throws when there is no commit stage", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_get", key: "some:key", storeAs: "val" },
                { method: "windup", value: () => null },
            ])
        ).rejects.toThrow(/Expected a commit stage after redis, redis-json or branch stages/i);
    });

    test("throws when last stage is not windup", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_get", key: "some:key", storeAs: "val" },
                { method: "commit" },
            ] as any)
        ).rejects.toThrow(/Last stage must be return stage/i);
    });

    test("throws when there are multiple windup stages", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_get", key: "some:key", storeAs: "val" },
                { method: "commit" },
                { method: "windup", value: () => "first" },
                { method: "windup", value: () => "second" },
            ] as any)
        ).rejects.toThrow(/only 1 return stage/i);
    });

    test("throws on commit with empty stack (two consecutive commits)", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_get", key: "some:key", storeAs: "val" },
                { method: "commit" },
                { method: "commit" },      // <-- nothing between the two commits
                { method: "windup", value: () => null },
            ])
        ).rejects.toThrow(/Unexpected 'commit' stage/i);
    });

    test("throws when validation fails (custom message surfaced)", async () => {
        await expect(
            aggregator.aggregate([
                { method: "json_get", key: "product:prod_002", storeAs: "product" },
                { method: "commit" },
                {
                    method: "validate",
                    ref: "product",
                    validate: (_s, p: Product) => p.stock > 0,
                    messageOnFailure: "Product is out of stock",
                },
                { method: "windup", value: (s) => s.get("product") },
            ])
        ).rejects.toThrow("Product is out of stock");
    });

    test("throws when branch returns a non-redis stage", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_smembers", key: `room:room_001:participants`, storeAs: "ids" },
                { method: "commit" },
                {
                    method: "branch",
                    ref: "ids",
                    explore: () => [
                        { method: "validate", validate: () => true } as any, // invalid inside branch
                    ],
                },
                { method: "commit" },
                { method: "windup", value: () => null },
            ])
        ).rejects.toThrow(/Only redis or redis-json stages are allowed/i);
    });

    test("throws when derive stage has an empty/falsy key", async () => {
        await expect(
            aggregator.aggregate([
                { method: "redis_get", key: "some:key", storeAs: "val" },
                { method: "commit" },
                {
                    method: "derive",
                    vals: () => ({ '': 42 }),// invalid key
                },
                { method: "windup", value: () => null },
            ])
        ).rejects.toThrow(/Invalid key/i);
    });
});