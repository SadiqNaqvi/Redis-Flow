import { RedisJson } from "~/json/src/engine"
import { handlePipelineResponse } from "~/shared/lib/utils";
import Redis from "ioredis"
import { config } from "dotenv";

config();

declare global {
    // allow global `redis` in dev
    // eslint-disable-next-line no-var
    var _redis: Redis | undefined;
}

export const getRedis = async () => {

    const redis_username = process.env.REDIS_USERNAME
    const redis_password = process.env.REDIS_PASSWORD
    const redis_host = process.env.REDIS_HOST
    const redis_port = parseInt(process.env.REDIS_PORT!)
    if (
        !redis_username ||
        !redis_password ||
        !redis_host ||
        !Number.isInteger(redis_port)
    ) {
        throw new Error("Enviroment variables for Redis are not available!")
    }

    if (!global._redis) {
        global._redis = new Redis({
            username: redis_username,
            password: redis_password,
            host: redis_host,
            port: redis_port,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > 5) {
                    // Stop retrying
                    console.warn("❌ Too many attempts to connect to Redis, giving up.");
                    return;
                }
                console.warn(`⚠️ Redis retry attempt #${times}`);
                return Math.min(times * 200, 2000); // exponential backoff (200ms -> 2s max)
            }
        });
    }
    if (global._redis.status === "end" || global._redis.status === "close")
        await global._redis.connect()
            .then(() => console.log("💪🙌 Redis Connected Successfully 🙌💪"))
            .catch((e: any) => {
                console.log("Redis Connection Failed:", e.message)
                global._redis?.disconnect();
            });

    return global._redis;
};


export type User = {
    user_id: string;
    username: string;
    email: string;
    avatar_url: string;
};

export type Room = {
    room_id: string;
    lastMessage: string;
    lastMessageAt: string;
};

export type ExpectedRoom = Room & {
    name: string;
    participant_id: string;
};

export type Product = {
    product_id: string;
    name: string;
    price: number;
    stock: number;
    category: string;
};

export type CartItem = {
    product_id: string;
    quantity: number;
};

export type Order = {
    order_id: string;
    status: "pending" | "processing" | "shipped" | "delivered";
    items: CartItem[];
};

export type LeaderboardEntry = {
    user_id: string;
    username: string;
    score: number;
    rank: number;
};

const currentUser = "user_001";

export const prepareAggregationTesting = async (redis: Redis) => {

    const pipeline = redis.pipeline();
    const redisJson = new RedisJson(pipeline);

    /* ---- Users ---- */
    const users: User[] = [
        { user_id: "user_001", username: "dark_wolf", email: "dark@wolf.io", avatar_url: "/avatars/001.png" },
        { user_id: "user_002", username: "spider_monkey", email: "spider@monk.io", avatar_url: "/avatars/002.png" },
        { user_id: "user_003", username: "king_tiger", email: "king@tiger.io", avatar_url: "/avatars/003.png" },
        { user_id: "user_004", username: "pink_dolphin", email: "pink@dolph.io", avatar_url: "/avatars/004.png" },
        { user_id: "user_005", username: "sweet_shark", email: "sweet@shark.io", avatar_url: "/avatars/005.png" },
    ];

    for (const u of users) redisJson.set(`user:${u.user_id}`, u);

    /* ---- Chat Rooms ---- */
    const rooms: Room[] = [
        { room_id: "room_001", lastMessage: "Hey, are we still meeting today?", lastMessageAt: "2026-05-05T09:15:00Z" },
        { room_id: "room_002", lastMessage: "I sent you the files.", lastMessageAt: "2026-05-05T09:10:00Z" },
        { room_id: "room_003", lastMessage: "Let's catch up tomorrow!", lastMessageAt: "2026-05-05T08:50:00Z" },
        { room_id: "room_004", lastMessage: "Game night tonight?", lastMessageAt: "2026-05-05T08:45:00Z" },
        { room_id: "room_005", lastMessage: "I'll call you in a bit.", lastMessageAt: "2026-05-05T07:30:00Z" },
    ];

    for (const r of rooms) redisJson.set(`room:${r.room_id}`, r);

    // room participants (sets)
    pipeline.sadd("room:room_001:participants", "user_001", "user_002");
    pipeline.sadd("room:room_002:participants", "user_001", "user_003");
    pipeline.sadd("room:room_003:participants", "user_001", "user_004");
    pipeline.sadd("room:room_004:participants", "user_001", "user_005");
    pipeline.sadd("room:room_005:participants", "user_001", "user_004");

    // user's sorted room list (score = unix timestamp for ordering)
    pipeline.zadd(`roomList:${currentUser}`,
        1746437700, "room_001",
        1746437400, "room_002",
        1746436200, "room_003",
        1746435900, "room_004",
        1746431400, "room_005"
    );

    /* ---- Products ---- */
    const products: Product[] = [
        { product_id: "prod_001", name: "Wireless Headphones", price: 79.99, stock: 25, category: "electronics" },
        { product_id: "prod_002", name: "Mechanical Keyboard", price: 129.99, stock: 0, category: "electronics" },
        { product_id: "prod_003", name: "Desk Lamp", price: 34.99, stock: 50, category: "home" },
        { product_id: "prod_004", name: "Notebook (A5)", price: 8.99, stock: 200, category: "stationery" },
        { product_id: "prod_005", name: "USB-C Hub", price: 49.99, stock: 15, category: "electronics" },
    ];
    for (const p of products) redisJson.set(`product:${p.product_id}`, p);

    // user cart (hash: product_id -> quantity)
    pipeline.hset(`cart:${currentUser}`,
        "prod_001", "2",
        "prod_003", "1",
        "prod_004", "3"
    );

    // product category index (set)
    pipeline.sadd("category:electronics", "prod_001", "prod_002", "prod_005");
    pipeline.sadd("category:home", "prod_003");
    pipeline.sadd("category:stationery", "prod_004");

    /* ---- Orders ---- */
    const orders: Order[] = [
        { order_id: "order_001", status: "delivered", items: [{ product_id: "prod_001", quantity: 1 }] },
        { order_id: "order_002", status: "shipped", items: [{ product_id: "prod_003", quantity: 2 }] },
        { order_id: "order_003", status: "pending", items: [{ product_id: "prod_004", quantity: 5 }] },
    ];
    for (const o of orders) redisJson.set(`order:${o.order_id}`, o);
    pipeline.lpush(`orders:${currentUser}`, "order_003", "order_002", "order_001");

    /* ---- Leaderboard ---- */
    pipeline.zadd("leaderboard:global",
        9850, "user_003",
        8200, "user_005",
        7500, "user_002",
        6100, "user_004",
        5400, "user_001"
    );

    /* ---- Followers / Following ---- */
    pipeline.sadd(`followers:user_001`, "user_002", "user_003", "user_004");
    pipeline.sadd(`following:user_001`, "user_003", "user_005");

    /* ---- Notifications ---- */
    pipeline.lpush(`notifications:${currentUser}`,
        JSON.stringify({ id: "notif_003", type: "like", message: "king_tiger liked your post" }),
        JSON.stringify({ id: "notif_002", type: "follow", message: "spider_monkey followed you" }),
        JSON.stringify({ id: "notif_001", type: "message", message: "New message in room_001" })
    );
    pipeline.set(`unreadCount:${currentUser}`, "3");

    await pipeline.exec().then(r => handlePipelineResponse(r, false, undefined));

}

export const cleanupAfterAggregationTesting = async (redis: Redis) => {
    await redis.del(
        "user:user_001",
        "user:user_002",
        "user:user_003",
        "user:user_004",
        "user:user_005",
        "room:room_001",
        "room:room_002",
        "room:room_003",
        "room:room_004",
        "room:room_005",
        "room:room_001:participants",
        "room:room_002:participants",
        "room:room_003:participants",
        "room:room_004:participants",
        "room:room_005:participants",
        `roomList:${currentUser}`,
        "product:prod_001",
        "product:prod_002",
        "product:prod_003",
        "product:prod_004",
        "product:prod_005",
        `cart:${currentUser}`,
        "category:electronics",
        "category:home",
        "category:stationery",
        "order:order_001",
        "order:order_002",
        "order:order_003",
        `orders:${currentUser}`,
        "leaderboard:global",
        `followers:user_001`,
        `following:user_001`,
        `notifications:${currentUser}`,
        `unreadCount:${currentUser}`,
    )
}