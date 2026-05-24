import { RedisJson } from "~/json/src/engine"
import { handlePipelineResponse } from "~/shared/lib/utils";
import Redis from "ioredis"
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

// const users: User[] = [
//     {
//         user_id: 'user_001',
//         username: "red_panda"
//     },
//     {
//         user_id: 'user_002',
//         username: "spider_monkey"
//     },
//     {
//         user_id: 'user_003',
//         username: "king_tiger"
//     },
//     {
//         user_id: 'user_004',
//         username: "pink_dolphin"
//     },
//     {
//         user_id: 'user_005',
//         username: "sweet_shark"
//     }
// ]

// const rooms: Room[] = [
//     {
//         room_id: "room_001",
//         lastMessage: "Hey, are we still meeting today?",
//         lastMessageAt: "2026-05-05T09:15:00Z"
//     },
//     {
//         room_id: "room_002",
//         lastMessage: "I sent you the files.",
//         lastMessageAt: "2026-05-05T09:10:00Z"
//     },
//     {
//         room_id: "room_003",
//         lastMessage: "Let's catch up tomorrow!",
//         lastMessageAt: "2026-05-05T08:50:00Z"
//     },
//     {
//         room_id: "room_004",
//         lastMessage: "Game night tonight?",
//         lastMessageAt: "2026-05-05T08:45:00Z"
//     },
//     {
//         room_id: "room_005",
//         lastMessage: "I'll call you in a bit.",
//         lastMessageAt: "2026-05-05T07:30:00Z"
//     }
// ]

// const participants: Participant[] = [
//     {
//         user_id: "user_001",
//         room_id: "room_001",
//         last_seen: "2026-05-05T09:15:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_002",
//         room_id: "room_001",
//         last_seen: "2026-05-05T09:10:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_001",
//         room_id: "room_002",
//         last_seen: "2026-05-05T08:50:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_003",
//         room_id: "room_002",
//         last_seen: "2026-05-05T08:45:00Z",
//         isHidden: true
//     },
//     {
//         user_id: "user_001",
//         room_id: "room_003",
//         last_seen: "2026-05-05T07:30:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_004",
//         room_id: "room_003",
//         last_seen: "2026-05-05T07:25:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_001",
//         room_id: "room_004",
//         last_seen: "2026-05-05T06:40:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_005",
//         room_id: "room_004",
//         last_seen: "2026-05-05T06:35:00Z",
//         isHidden: true
//     },
//     {
//         user_id: "user_004",
//         room_id: "room_005",
//         last_seen: "2026-05-05T05:20:00Z",
//         isHidden: false
//     },
//     {
//         user_id: "user_005",
//         room_id: "room_005",
//         last_seen: "2026-05-05T05:15:00Z",
//         isHidden: false
//     }
// ]

// export const prepareAggregationTesting = async (redis: Redis) => {

//     const pipeline = redis.pipeline();
//     const json = new RedisJson(pipeline);

//     pipeline.zadd("roomList:user_001", ...rooms.map(r => [new Date(r.lastMessageAt).getTime(), r.room_id]).flat())

//     rooms.forEach(room => {
//         json.set(`room:${room.room_id}`, room)
//         pipeline.sadd(
//             `room:${room.room_id}:participants`,
//             ...participants
//                 .filter(p => p.room_id === room.room_id)
//                 .map(p => p.user_id)
//         )
//     })

//     users.forEach(user => json.set(`user:${user.user_id}`, user))
//     participants.forEach(p => json.set(`room:${p.user_id}:participant:${p.user_id}`, p))

//     await pipeline.exec();

// }

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

export const cleanupAfterTesting = async (redis: Redis) => {
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

export const seedRedisForEasyTests = async (redis: Redis) => {

    const pipeline = redis.pipeline();
    const redisJson = new RedisJson(pipeline);
    redisJson.set(
        `user:user_002`,
        { user_id: "user_002", username: "spider_monkey", email: "spider@monk.io", avatar_url: "/avatars/002.png" }
    );

    pipeline.sadd("room:room_001:participants", "user_001", "user_002");
    pipeline.set(`unreadCount:${currentUser}`, "3");
    pipeline.hset(`cart:${currentUser}`,
        "prod_001", "2",
        "prod_003", "1",
        "prod_004", "3"
    );

    pipeline.lpush(`orders:${currentUser}`, "order_003", "order_002", "order_001");

    await pipeline.exec();

}

export const cleanupAfterEasyTest = async (redis: Redis) => {
    await redis.del(
        "user:user_002",
        "room:room_001:participants",
        `unreadCount:${currentUser}`,
        "3",
        `cart:${currentUser}`,
        `orders:${currentUser}`
    );
}


export const seedRedisForMediumTests = async (redis: Redis) => {

    const pipeline = redis.pipeline();
    const redisJson = new RedisJson(pipeline);

    redisJson.set(
        "product:prod_001",
        { product_id: "prod_001", name: "Wireless Headphones", price: 79.99, stock: 25, category: "electronics" }
    );

    // pipeline.sadd("room:room_001:participants", "user_001", "user_002");
    // pipeline.set(`unreadCount:${currentUser}`, "3");
    pipeline.zadd(`roomList:${currentUser}`,
        1746437700, "room_001",
        1746437400, "room_002",
        1746436200, "room_003",
        1746435900, "room_004",
        1746431400, "room_005"
    );
    pipeline.hset(`cart:${currentUser}`,
        "prod_001", "2",
        "prod_003", "1",
        "prod_004", "3"
    );

    pipeline.lpush(`orders:${currentUser}`, "order_003", "order_002", "order_001");

    await pipeline.exec();

}

export const cleanupAfterMediumTests = async (redis: Redis) => {
    await redis.del(
        "user:user_002",
        "room:room_001:participants",
        `unreadCount:${currentUser}`,
        "3",
        `cart:${currentUser}`,
        `orders:${currentUser}`
    );
}