<div align="center">

<h1>Redis Flow</h1>

<p>A driver-agnostic TypeScript library for working with Redis - cleanly, expressively, and atomically.</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Edge Ready](https://img.shields.io/badge/Edge-Ready-brightgreen)](https://workers.cloudflare.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Overview

Redis Flow ships two independent packages built on a shared core:

| Package                                           | Description                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| [`@redis-flow/json`](#redis-flowjson)             | Typed, atomic, rollback-proof mutations for RedisJSON documents           |
| [`@redis-flow/aggregator`](#redis-flowaggregator) | Multi-key pipeline engine for fetching, shaping, and combining Redis data |

Both packages work with **any Redis driver** - ioredis, node-redis, Upstash, or anything else - and run in Edge environments including Cloudflare Workers, Vercel Edge Functions, and Deno Deploy.

---

## Table of Contents

- [Installation](#installation)
- [Redis Flow JSON](#redis-flowjson)
  - [Why not @redis/json?](#why-not-redisjson)
  - [Quick Start](#quick-start)
  - [Dual-mode: Standard vs Pipeline](#dual-mode-standard-vs-pipeline)
  - [Path Syntax](#path-syntax)
  - [Methods](#methods)
  - [Atomicity and Rollback](#atomicity-and-rollback)
  - [Configuration](#configuration)
- [Redis Flow Aggregator](#redis-flowaggregator)
  - [The Problem it Solves](#the-problem-it-solves)
  - [Quick Start](#quick-start-1)
  - [Stage Reference](#stage-reference)
  - [Real-World Example](#real-world-example)
  - [API](#api)
  - [Configuration](#configuration-1)
- [Driver Compatibility](#driver-compatibility)
- [Package Architecture](#package-architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
# Install only what you need
npm install @redis-flow/json
npm install @redis-flow/aggregator

# Or both at once
npm install @redis-flow/json @redis-flow/aggregator
```

---

## @redis-flow/json

### Why not `@redis/json`?

The official package exposes raw RedisJSON commands. It works, but it leaves a lot on the table:

|                                   | `@redis/json` | `@redis-flow/json` |
| --------------------------------- | :-----------: | :----------------: |
| TypeScript path autocomplete      |      ❌       |         ✅         |
| Atomic multi-field mutations      |      ❌       |         ✅         |
| Automatic rollback on error       |      ❌       |         ✅         |
| Fetch partial document (`pick`)   |      ❌       |         ✅         |
| Multi-operation patch in one call |      ❌       |         ✅         |
| Pipeline mode                     |      ✅       |         ✅         |
| Driver-agnostic                   |      ❌       |         ✅         |
| Edge environment support          |      ❌       |         ✅         |

---

### Quick Start

```ts
import { RedisJson } from "@redis-flow/json";

const json = new RedisJson(redis);

type User = {
  name: string;
  age: number;
  email: string;
  tags: string[];
  isActive: boolean;
  score: number;
};

// Create a document
await json.set<User>("user:1", {
  name: "Alice",
  age: 30,
  email: "alice@example.com",
  tags: ["beta"],
  isActive: true,
  score: 0,
});

// Read the full document
const user = await json.get<User>("user:1");

// Read specific fields only - only those fields are transferred over the wire
const partial = await json.pick<User>("user:1", {
  name: true,
  age: true,
});
// -> { name: "Alice", age: 30 }

// Update multiple fields atomically - either all succeed or none apply
await json.update<User>("user:1", {
  name: "Alice Smith",
  age: 31,
});

// Complex multi-operation patch - all in one round-trip, all atomic
await json.patch<User>("user:1", {
  $set: { email: "alice.smith@example.com" },
  $toggle: { isActive: true },
  $number: { $inc_by: { score: 100 } },
  $array: { $append: { tags: ["verified"] } },
  $appendInString: { name: " Jr." },
});
```

---

### Dual-mode: Standard vs Pipeline

Pass a plain Redis instance for **standard mode** - every mutating call compiles to a single atomic `EVALSHA` round-trip via a server-side Lua script.

```ts
const json = new RedisJson(redis);

await json.update("user:1", { name: "Bob" }); // -> Promise<"OK">
```

Pass `redis.pipeline()` for **pipeline mode** - calls queue commands without executing until `.exec()` is called. Use this when batching document reads alongside other Redis commands.

```ts
const json = new RedisJson(redis.pipeline());

json.get("user:1");
json.get("user:2");
json.get("user:3");

const [user1, user2, user3] = await json.exec();
```

> **Note:** Pipeline mode does not use the Lua script. Atomicity is not guaranteed across a pipeline - use standard mode when mutations must be all-or-nothing.

---

### Path Syntax

All methods accept a `FieldPath`, which can be written in three ways.

**Raw string** - passed through verbatim to Redis:

```ts
json.pick("user:1", "$.address.city");
```

**String array** - multiple paths in one call:

```ts
json.pick("user:1", ["$.name", "$.email"]);
```

**Path object (recommended)** - type-safe, autocompletion-friendly:

```ts
json.pick<User>("user:1", {
  name: true,
  address: { city: true },
});
```

**Array indexing with `$index`:**

```ts
// First element
json.pick("user:1", { tags: { $index: 0 } });

// Multiple specific indices
json.pick("user:1", { tags: { $index: [0, 2, 4] } });

// Nested array
json.pick("user:1", {
  hobbies: { indoor: { $index: 1 } },
});
```

**Deep traversal with `$path`:**

```ts
// Equivalent to $.matrix[0][2]
json.pick("user:1", { matrix: { $path: [0, 2] } });
```

---

### Methods

#### Read

```ts
// Full document
json.get<T>(key)

// Partial document - only the requested fields are transferred
json.pick<T>(key, path, config?)

// Field types - returns "string" | "integer" | "number" | "boolean" | "object" | "array" | "null" | null
json.type(key, path?, config?)

// Character length of string fields
json.strLen(key, path, config?)

// Number of keys in object fields
json.objLen(key, path?, config?)

// Key names of object fields
json.objKeys(key, path?, config?)
```

#### Write

All write methods accept an optional third config argument:

```ts
// Return the updated document in the same round-trip (no separate GET needed)
{
  returns: "mutated document";
}

// Return the original document before the mutation (useful for optimistic locking)
{
  returns: "non mutated document";
}
```

```ts
// Create or fully replace a document
json.set<T>(key, value, config?)

// Set specific fields - all other fields are preserved
json.update<T>(key, value, config?)

// Deep-merge an object - new keys added, existing keys overwritten, absent keys untouched
json.merge<T>(key, value, config?)

// Multi-operation patch - the most expressive write method
json.patch<T>(key, value, config?)

// Delete fields, or the whole document when path is omitted
json.del<T>(key, path?, config?)

// Append to string fields
json.strAppend<T>(key, value, config?)

// Increment numeric fields
json.numIncrBy<T>(key, value, config?)

// Multiply numeric fields
json.numMultBy<T>(key, value, config?)

// Push elements to the end of array fields
json.arrAppend<T>(key, value, config?)

// Insert elements at a specific index in array fields
json.arrInsert<T>(key, value, config?)

// Retain only the [start, stop] slice of array fields (both bounds inclusive)
json.arrTrim<T>(key, value, config?)

// Remove and return an element from array fields (default: last element)
json.arrPop<T>(key, value, config?)

// Flip boolean fields
json.toggle<T>(key, value, config?)
```

#### `patch` operations at a glance

```ts
await json.patch<User>("user:1", {
  // Set field values
  $set: { status: "active" },

  // Deep-merge into an existing object field
  $merge: { address: { country: "UK" } },

  // Flip boolean fields
  $toggle: { isActive: true },

  // Append to string fields
  $appendInString: { name: " Jr." },

  // Array operations
  $array: {
    $append: { tags: ["premium"] }, // push to end
    $insert: { tags: { $index: 0, $value: "vip" } }, // insert at index
    $trim: { recentItems: [0, 49] }, // keep first 50
    $pop: { notifications: true }, // remove last element
  },

  // Numeric operations
  $number: {
    $inc_by: { score: 100 }, // add
    $mul_by: { price: 0.9 }, // multiply (10% discount)
  },
});
```

---

### Atomicity and Rollback

Every write call in standard mode compiles to a single `EVALSHA` against a server-side Lua script. The script works in three steps:

1. **Snapshot.** The full document is captured with `JSON.GET` before anything runs.
2. **Execute with inline validation.** Each operation validates its precondition - type check, path existence - and immediately executes if the check passes. If a check fails, the error is recorded and all remaining operations are skipped.
3. **Rollback on error.** If any error was recorded, the snapshot is restored. If the document did not exist before the batch, it is deleted rather than restored - leaving Redis exactly as it was.

```ts
// doc: { count: 5, label: "hello" }

// ❌ Fails - "label" is a string, not a number.
// "count" is incremented to 6 mid-script, but the snapshot is restored on error.
await json.patch("doc", {
  $number: { $inc_by: { count: 1, label: 1 } },
});

// doc is still: { count: 5, label: "hello" }
```

Because validation and execution are **interleaved**, an earlier operation can create a field that a later operation in the same call immediately acts on:

```ts
// ✅ Works - set runs and creates .arr first,
// so arrAppend validates it correctly as an array.
await json.patch("doc", {
  $set: { arr: [] },
  $array: { $append: { arr: ["first"] } },
});
```

---

### Configuration

```ts
const json = new RedisJson(redis, {
  // Log each operation and its timing to console
  debug: false,

  // Custom normaliser for non-ioredis pipeline output formats
  pipelineResponseHandler: (rawResult) => rawResult.map(([, value]) => value),
});
```

Per-call accessor config:

```ts
json.pick(
  "user:1",
  { tags: true },
  {
    // Keep sparse array indices instead of compacting them into a dense array
    preserveArrayIndices: false,
  },
);
```

---

## @redis-flow/aggregator

### The Problem it Solves

Most Redis-backed endpoints look like this:

```ts
const user = await redis.json.get(`user:${id}`);
const settings = await redis.json.get(`settings:${id}`);
const rooms = await redis.zrevrange(`roomList:${id}`, 0, 9);
const unread = await redis.get(`unread:${id}`);
```

Four sequential `await` calls. Four separate round-trips. Each one blocks before the next begins - and that's before any N+1 lookups (fetching room documents, participant profiles, etc.) that multiply the problem further.

Redis Aggregator fixes this at the architecture level:

- All Redis commands between two `commit` stages are sent as a **single pipeline** - one round-trip per batch, regardless of how many keys are fetched.
- `branch` stages solve N+1 lookups declaratively: given a list of IDs already in the store, they dynamically generate one fetch stage per ID and batch them all together with the next `commit`.
- The entire pipeline is a plain array of stage objects - readable, composable, and statically analysable with `.explain()` before any Redis call is made.

---

### Quick Start

```ts
import { RedisAggregator } from "@redis-flow/aggregator";

const aggregator = new RedisAggregator(redis);

type DashboardData = {
  user: User;
  settings: Settings;
  unreadCount: number;
};

const dashboard = await aggregator.aggregate<DashboardData>([
  // Stage 1 - queue three fetches in one batch
  { method: "json_get", key: `user:${id}`, ref: "user" },
  { method: "json_get", key: `settings:${id}`, ref: "settings" },
  { method: "redis_get", key: `unread:${id}`, ref: "unreadCount" },

  // Stage 2 - flush as one pipeline (one round-trip)
  { method: "commit" },

  // Guard before proceeding
  {
    method: "validate",
    ref: "user",
    validate: (_, user) => !!user,
    messageOnFailure: "User not found",
  },

  // Assemble the result
  {
    method: "windup",
    value: (store) => ({
      user: store.get("user"),
      settings: store.get("settings"),
      unreadCount: store.get("unreadCount"),
    }),
  },
]);
```

---

### Stage Reference

#### `redis_*` - Redis commands

```ts
{ method: "redis_get",       key: "session:abc" }
{ method: "redis_hgetall",   key: "user:42:meta" }
{ method: "redis_zrevrange", key: "leaderboard", ref: "top10", args: [0, 9] }
{ method: "redis_smembers",  key: "room:7:members", ref: "members" }
```

Supported commands: `get` `getBuffer` `mget` `strlen` `getrange` `hget` `hgetall` `hmget` `hkeys` `hvals` `hlen` `hexists` `lindex` `lrange` `llen` `smembers` `sismember` `scard` `srandmember` `zrange` `zrevrange` `zrangebyscore` `zrevrangebyscore` `zscore` `zrank` `zrevrank` `zcard` `zcount` `exists` `type` `ttl` `pttl` `bitcount` `getbit` `pfcount` `xrange` `xrevrange`

Both `redis_*` and `json_*` stages accept an optional `ref` field that overrides the key used when storing the result - useful when the Redis key contains `:` characters that are awkward to pass to `store.get()`.

---

#### `json_*` - RedisJSON reads

```ts
{ method: "json_get",  key: "user:42" }
{ method: "json_pick", key: "user:42", ref: "summary", path: { name: true, email: true } }
{ method: "json_type", key: "user:42", path: "status" }
```

Supported: `json_get` `json_pick` `json_type` `json_strLen` `json_objLen` `json_objKeys`

---

#### `branch` - dynamic stage injection

The solution to N+1. Receives the current store state and returns additional `redis_*` / `json_*` stages to inject into the current pending batch.

```ts
{
    method: "branch",
    ref: "roomIds",  // passes store.get("roomIds") as 2nd argument to explore
    explore: (store, roomIds: string[]) =>
        roomIds.map(id => ({ method: "json_get", key: `room:${id}` })),
}
```

Constraints: returned stages must be `redis_*` or `json_*` only, maximum 99 per branch call, all keys must be unique and not already present in the store.

---

#### `derive` - computed values, no Redis call

```ts
{
    method: "derive",
    ref: "participants",
    vals: (store, participants: string[]) => ({
        count:       participants.length,
        isGroupChat: participants.length > 2,
    }),
}
```

---

#### `transform` - in-place store modification

```ts
{
    method: "transform",
    key: "messages",
    transform: (_, messages: RawMessage[]) =>
        messages.map(m => ({ ...m, timestamp: new Date(m.ts) })),
}
```

---

#### `validate` - guard conditions

```ts
{
    method: "validate",
    ref: "user",
    validate: (store, user) => user !== null,
    messageOnFailure: "User not found",
}
```

---

#### `commit` - flush the batch

Each `commit` is exactly **one Redis round-trip**.

```ts
{ method: "commit" }

// Allow no-op if the preceding branch produced no stages
{ method: "commit", allowEmptyBatch: true }
```

---

#### `windup` - assemble the result

Must be the last stage. The pipeline stops here.

```ts
{
    method: "windup",
    value: (store) => ({
        user:  store.get<User>("user"),
        rooms: store.get<Room[]>("rooms"),
    }),
}
```

---

### Real-World Example

An endpoint returning a user's chat rooms, each enriched with the other participant's name and avatar. Naive approach: **2N + 2 sequential round-trips**. With Redis Aggregator: **3 round-trips**, regardless of N.

```ts
const currentUser = "user:99";

const rooms = await aggregator.aggregate<EnrichedRoom[]>([
  // ── Round-trip 1 ──────────────────────────────────────────────────
  {
    method: "redis_zrevrange",
    key: `roomList:${currentUser}`,
    ref: "roomIds",
    args: [0, 9],
  },
  { method: "commit" },
  // ──────────────────────────────────────────────────────────────────

  {
    method: "validate",
    ref: "roomIds",
    validate: (_, ids: string[]) => !!ids?.length,
    messageOnFailure: "No rooms found",
  },

  // Inject one json_get + one smembers per room - both land in the same batch
  {
    method: "branch",
    ref: "roomIds",
    explore: (_, ids: string[]) =>
      ids.map((id) => ({ method: "json_get", key: `room:${id}` })),
  },
  {
    method: "branch",
    ref: "roomIds",
    explore: (_, ids: string[]) =>
      ids.map((id) => ({
        method: "redis_smembers",
        key: `room:${id}:participants`,
        ref: `participants_${id}`,
      })),
  },

  // ── Round-trip 2 ──────────────────────────────────────────────────
  { method: "commit" },
  // ──────────────────────────────────────────────────────────────────

  // Build a roomId -> otherUserId map without a Redis call
  {
    method: "derive",
    ref: "roomIds",
    vals: (store, ids: string[]) => {
      const map = ids.reduce(
        (acc, id) => {
          const others = (
            store.get<string[]>(`participants_${id}`) ?? []
          ).filter((u) => u !== currentUser);
          return others[0] ? { ...acc, [id]: others[0] } : acc;
        },
        {} as Record<string, string>,
      );

      return { roomToUser: map };
    },
  },

  // Fetch every other participant's profile in one batch
  {
    method: "branch",
    ref: "roomToUser",
    explore: (_, map: Record<string, string>) =>
      Object.values(map).map((userId) => ({
        method: "json_get",
        key: `user:${userId}`,
      })),
  },

  // ── Round-trip 3 ──────────────────────────────────────────────────
  { method: "commit" },
  // ──────────────────────────────────────────────────────────────────

  {
    method: "windup",
    value: (store) => {
      const ids = store.get<string[]>("roomIds");
      const map = store.get<Record<string, string>>("roomToUser");

      return ids.map((id) => {
        const room = store.get<Room>(`room:${id}`);
        const userId = map[id];
        const user = store.get<User>(`user:${userId}`);
        return {
          ...room,
          participantName: user.name,
          participantAvatar: user.avatar,
        };
      });
    },
  },
]);
```

---

### API

```ts
// Execute a pipeline - throws on any error
const result = await aggregator.aggregate<T>(stages, { signal? });

// Execute safely - returns a result envelope instead of throwing
const { success, result, error } = await aggregator.aggregateSafe<T>(stages, { signal? });

// Fluent chain API - equivalent to the array form
const result = await aggregator
    .push({ method: "json_get", key: "user:1" })
    .commit()
    .validate((s) => !!s.get("user:1"), undefined, "Not found")
    .windup((s) => s.get("user:1"));

// Static analysis - inspect the pipeline without executing it
const plan = aggregator.explain(stages);
console.log(plan.summary);
// "Pipeline has 7 stage(s) across 2 Redis pipeline batch(es) executing 12 command(s).
//  Each batch costs exactly 1 Redis round-trip, for a minimum of 2 round-trip(s)."
```

---

### Configuration

```ts
const aggregator = new RedisAggregator(redis, {
  // Log each stage and pipeline result to console
  debug: false,

  // Throw if the entire aggregation exceeds this duration (seconds)
  timeoutInSeconds: 10,

  // External cancellation - checked before every stage
  signal: abortController.signal,

  // When true, failed pipeline commands produce null instead of throwing
  swallowPipelineErrors: false,

  // Keep sparse array indices in RedisJSON responses
  preserveArrayIndices: false,

  // Custom normaliser for non-ioredis pipeline output formats
  pipelineResponseHandler: (rawResult) => rawResult.map(([, value]) => value),
});
```

---

## Driver Compatibility

Redis Flow does not couple to any specific driver. The only assumption is that your pipeline's `.exec()` call returns results as `[error | null, value][]` tuples - the ioredis default.

If your driver's output differs, pass a `pipelineResponseHandler` to normalise it:

```ts
// node-redis example
const config = {
  pipelineResponseHandler: (raw) => raw.map((entry) => entry.result ?? null),
};

const json = new RedisJson(redis, config);
const aggregator = new RedisAggregator(redis, config);
```

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feat/my-feature`
5. Open a Pull Request

---

## License

MIT © Redis Flow Contributors
