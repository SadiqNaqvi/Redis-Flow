# Redis Aggregator

Fetch data from multiple Redis keys, transform it, validate it, branch into dynamic lookups, and return exactly the shape your application needs - in as few Redis round-trips as the problem allows.

---

## Why does this exist?

Most Redis usage patterns look like this: fetch a user, fetch their settings, fetch their last 10 messages, stitch everything together. In practice that turns into 3–10 sequential `await redis.get(...)` calls scattered across service files, each one a separate network round-trip.

The problems stack up:

- **Latency multiplies.** Every `await` is a blocking round-trip. Five sequential calls at 1ms each is 5ms of pure wait time before your code does anything useful.
- **Logic leaks.** The stitching, validation, and shaping code ends up everywhere - in API handlers, service classes, middleware - and it's never quite the same.
- **Reuse is hard.** A "get user with their settings" sequence gets copy-pasted into a dozen places instead of being defined once.

Redis Aggregator solves all three:

1. **Pipeline batching.** All Redis / RedisJSON commands between two `.commit()` calls are sent to Redis in a single pipeline, costing exactly **one round-trip** per batch - no matter how many keys you fetch.
2. **Declarative pipeline.** A pipeline is a plain array of stage objects (or a fluent chain). It reads like a recipe: _fetch these keys, validate this condition, branch into these dynamic keys, derive this computed value, return this shape._
3. **Composable base pipelines.** Build a "fetch user" base pipeline once. Combine it with a "fetch settings" pipeline for the profile page, or a "fetch rooms" pipeline for the dashboard - no duplication.

---

## Installation

```bash
npm install @redis-flow/aggregator
```

---

## Quick start

```ts
import { RedisAggregator } from "<package-name>";

const aggregator = new RedisAggregator(redis);

const user = await aggregator.aggregate([
    // Stage 1: fetch the user document
    { method: "json_get", key: "user:42", storeAs: "user" },

    // Stage 2: flush the pipeline. (one Redis round-trip)
    { method: "commit" },

    // Stage 3: assemble the result
    { method: "windup", value: (store) => store.get("user") },
]);
```

---

## Core concepts

### The store

The store is a key-value map that accumulates results as the pipeline runs. Every Redis or RedisJSON stage writes its result into the store under its `key` (or `storeAs`, if provided). Helper stages like `derive` can also write to it. Later stages - including other `branch` stages and the final `windup` - can read from it.

The store is **read-only** inside helper stage callbacks. The only way to write to it is through declared stages, which prevents accidental mutations and makes the data flow easy to trace.

### Stages

A pipeline is an ordered array of stages. There are two categories:

**Data stages** - fetch data from Redis or perform in-process operations on the store:

| Stage | What it does |
|---|---|
| `redis_*` | Calls any allowed Redis read command (`GET`, `HGETALL`, `SMEMBERS`, `ZREVRANGE`, etc.) |
| `json_*` | Calls a `RedisJson` read command (`json_get`, `json_pick`, `json_type`, etc.) |
| `branch` | Dynamically generates additional `redis_*` / `json_*` stages based on current store values |
| `derive` | Computes new values from existing store data and saves them to the store |
| `transform` | Replaces a single store value with a transformed version |
| `validate` | Asserts a condition on the store; throws a descriptive error if it fails |

**Control stages** - control execution flow:

| Stage | What it does |
|---|---|
| `commit` | Flushes all pending `redis_*` / `json_*` stages as a single pipeline batch |
| `windup` | Assembles and returns the final value. **Must be the last stage.** |

### Structural rules

The pipeline validator enforces these rules before any Redis call is made:

1. The first stage must be a `redis_*` or `json_*` stage.
2. The last stage must be `windup`.
3. There must be exactly one `windup`.
4. Every `redis_*` / `json_*` / `branch` segment must be followed by a `commit`.
5. Stages cannot be empty.

Violations throw a descriptive error that names the offending stage and its index.

---

## Stage reference

### `redis_*` stages

Wraps any read command from the allowed Redis methods list. The `method` field is the command name prefixed with `redis_` (e.g. `redis_get`, `redis_hgetall`, `redis_smembers`).

```ts
// GET
{ method: "redis_get", key: "session:abc" }

// HGETALL
{ method: "redis_hgetall", key: "user:42:settings" }

// ZREVRANGE with args
{ method: "redis_zrevrange", key: "leaderboard", storeAs: "top10", args: [0, 9] }

// SMEMBERS - store result under a custom `storeAs` instead of the key
{ method: "redis_smembers", key: "room:7:participants", storeAs: "participants" }
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `method` | `redis_<command>` | ✓ | The Redis command to call, prefixed with `redis_`. |
| `key` | `string` | ✓ | The Redis key to operate on. Also used as the store key unless `storeAs` is set. |
| `storeAs` | `string` | - | Override the store key. Use when `key` contains characters like `:` that are awkward in store lookups. |
| `args` | `unknown[]` | varies | Extra arguments required by the command (e.g. range start/stop for `ZREVRANGE`). |

**Full list of supported commands:**

`get`, `getBuffer`, `mget`, `strlen`, `getrange`, `hget`, `hgetall`, `hmget`, `hkeys`, `hvals`, `hlen`, `hexists`, `lindex`, `lrange`, `llen`, `smembers`, `sismember`, `scard`, `srandmember`, `zrange`, `zrevrange`, `zrangebyscore`, `zrevrangebyscore`, `zscore`, `zrank`, `zrevrank`, `zcard`, `zcount`, `exists`, `type`, `ttl`, `pttl`, `bitcount`, `getbit`, `pfcount`, `xrange`, `xrevrange`

---

### `json_*` stages

Wraps a `RedisJson` read method. The `method` field is the command name prefixed with `json_`.

```ts
// Fetch the full document
{ method: "json_get", key: "user:42" }

// Fetch specific fields
{ method: "json_pick", key: "user:42", storeAs: "userFields", path: { name: true, email: true } }

// Type check
{ method: "json_type", key: "user:42", path: "status" }
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `method` | `json_<command>` | ✓ | The RedisJson command, prefixed with `json_`. |
| `key` | `string` | ✓ | The Redis key of the JSON document. |
| `storeAs` | `string` | - | Override the store key. |
| `path` | `FieldPath` | varies | Required for `json_pick`, `json_strLen`. Optional for `json_type`, `json_objLen`, `json_objKeys`. |

**Supported commands:** `json_get`, `json_pick`, `json_type`, `json_strLen`, `json_objLen`, `json_objKeys`

---

### `commit`

Flushes all pending `redis_*` / `json_*` stages as a single Redis pipeline, then maps results into the store. Costs exactly **one Redis round-trip**.

```ts
{ method: "commit" }

// Allow an empty batch (no error if no redis stages precede this commit)
{ method: "commit", allowEmptyBatch: true }
```

You can have multiple `commit` stages in a single pipeline. Each one is an independent round-trip. Use them strategically: if the second batch depends on results from the first, you need two commits. If not, you can merge them into one batch.

---

### `validate`

Asserts a condition. If the condition returns `false` or a rejected promise, the pipeline throws an error and stops.

```ts
{
    method: "validate",
    ref: "user", // optional - passes store.get("user") as 2nd arg
    validate: (store, user) => !!user, // (store, val?) => boolean | Promise<boolean>
    messageOnFailure: "User not found", // optional custom error message
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `validate` | `(store, val?) => boolean \| Promise<boolean>` | ✓ | The condition to assert. |
| `ref` | `string` | - | Store key whose value is passed as the second argument to `validate`. |
| `messageOnFailure` | `string` | - | Custom error message. Defaults to `"Validation failed at stage N"`. |

---

### `branch`

Dynamically generates additional `redis_*` / `json_*` stages based on the current state of the store. The returned stages are pushed into the current pending batch and flushed with the next `commit`.

This is the key to solving **N+1 lookup patterns** without hardcoding how many keys to fetch.

```ts
{
    method: "branch",
    ref: "roomIds", // optional - passes store.get("roomIds") as 2nd arg
    explore: (store, roomIds: string[]) => roomIds.map(id => ({
        method: "json_get",
        key: `room:${id}`,
    })),
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `explore` | `(store, val?) => ExtendedRedisStage[] \| Promise<ExtendedRedisStage[]>` | ✓ | Returns the stages to inject into the current batch. |
| `ref` | `string` | - | Store key whose value is passed as the second argument to `explore`. |

**Constraints:**
- Returned stages must be `redis_*` or `json_*` only (no nested `branch`, `commit`, etc.).
- Maximum 99 stages per branch call.
- Returned stage keys must be unique and not already in the store.

> **Tip:** `.explain()` will warn you that a `branch` stage's exact commands are unknown at static analysis time. This is expected - it is a dynamic stage by design.

---

### `derive`

Computes new values from existing store data and writes them to the store. No Redis call is made. Use it to prepare computed fields (maps, totals, derived IDs) that later `branch` or `windup` stages will need.

```ts
{
    method: "derive",
    ref: "participants",   // optional - passes store.get("participants") as 2nd arg
    vals: (store, participants: string[]) => ({
        participantCount: participants.length,
        isGroupChat: participants.length > 2,
    }),
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `vals` | `(store, val?) => Record<string, unknown> \| Promise<...>` | ✓ | Returns an object whose entries are written into the store. |
| `ref` | `string` | - | Store key whose value is passed as the second argument to `vals`. |

**Constraints:** All returned keys must be non-empty strings not already in the store.

---

### `transform`

Replaces a single store value with a transformed version. Unlike `derive` (which adds new keys), `transform` overwrites an existing key in place.

```ts
{
    method: "transform",
    key: "messages",
    transform: (store, messages: RawMessage[]) =>
        messages.map(m => ({ ...m, timestamp: new Date(m.ts) })),
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | `string` | ✓ | The store key whose value will be replaced. Must already exist. |
| `transform` | `(store, value) => unknown \| Promise<unknown>` | ✓ | Returns the new value to overwrite the store key with. |

---

### `windup`

Assembles and returns the final result. Must always be the last stage. Receives the read-only store and returns whatever value the caller expects.

```ts
{
    method: "windup",
    value: (store) => ({
        user: store.get("user"),
        settings: store.get("settings"),
        unreadCount: store.get("unreadCount"),
    }),
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `value` | `(store: AggregatorStore) => T \| Promise<T>` | ✓ | Assembles the return value from the store. |

---

## API reference

### `new RedisAggregator(redis, config?)`

```ts
const aggregator = new RedisAggregator(redis, {
    debug: false,                  // Log pipeline steps to console
    timeoutInSeconds: 10,          // Abort if aggregation exceeds this duration
    signal: abortController.signal, // AbortSignal for cancellation
    swallowPipelineErrors: false,  // Suppress per-command pipeline errors (slots become null)
    preserveArrayIndices: false,   // Keep sparse array indices from JSON.GET responses
    pipelineResponseHandler: fn,   // Custom pipeline response normaliser
});
```

### `.aggregate<T>(stages, config?)`

Executes a pipeline defined as a plain stage array. Throws on any error.

```ts
const result = await aggregator.aggregate<User[]>([
    { method: "json_get", key: "user:1" },
    { method: "commit" },
    { method: "windup", value: (s) => s.get("user:1") },
]);
```

### `.aggregateSafe<T>(stages, config?)`

Same as `.aggregate`, but wraps the result in a `{ success, result } | { success, error }` envelope instead of throwing.

```ts
const { success, result, error } = await aggregator.aggregateSafe<User>(stages);
```

### Fluent chain API

Instead of passing a pre-built array, you can chain stages on the aggregator instance:

```ts
const result = await aggregator
    .push({ method: "json_get", key: "user:1" })
    .commit()
    .validate((store) => !!store.get("user:1"), undefined, "User not found")
    .windup((store) => store.get("user:1"));
```

### `.explain(stages?)`

Statically analyses a stage array (or the current chain) without executing it. Returns a detailed `ExplainResult` object listing every batch, every command, estimated round-trips, and any warnings (e.g. dynamic `branch` stages, missing `commit`).

```ts
const explanation = aggregator.explain(stages);
console.log(explanation.summary);
// "Pipeline has 7 stage(s) across 2 Redis pipeline batch(es) executing 12 command(s). Each batch costs exactly 1 Redis round-trip, for a minimum of 2 round-trip(s)."
```

---

## Real-world example: chat room list

Imagine building an endpoint that returns a user's chat rooms enriched with the other participant's name and profile picture. A naive implementation makes N+2 sequential round-trips (1 for the room list, N for room documents, N for user documents).

With Redis Aggregator, this collapses to **3 round-trips**, regardless of N:

```ts
const currentUser = "user:99";

const rooms = await aggregator.aggregate<EnrichedRoom[]>([
    // Round-trip 1: fetch the user's room list (a sorted set)
    {
        method: "redis_zrevrange",
        key: `roomList:${currentUser}`,
        storeAs: "roomIds",
        args: [0, 9],
    },
    { method: "commit" },

    // Guard: fail fast if there are no rooms
    {
        method: "validate",
        ref: "roomIds",
        validate: (_, ids: string[]) => !!(ids && ids.length),
        messageOnFailure: "No rooms found for this user",
    },

    // Dynamically inject one json_get per room and one smembers per room.
    // Both branches go into the same pending batch.
    {
        method: "branch",
        ref: "roomIds",
        explore: (_, ids: string[]) => ids.map(id => ({
            method: "json_get", key: `room:${id}`,
        })),
    },
    {
        method: "branch",
        ref: "roomIds",
        explore: (_, ids: string[]) => ids.map(id => ({
            method: "redis_smembers",
            key: `room:${id}:participants`,
            storeAs: `participants_${id}`,
        })),
    },

    // Round-trip 2: flush room docs + participant sets
    { method: "commit" },

    // Build a roomId -> otherUserId lookup without any Redis call
    {
        method: "derive",
        ref: "roomIds",
        vals: (store, ids: string[]) => {
            const map = ids.reduce((acc, id) => {
                const participants = store.get<string[]>(`participants_${id}`);
                const other = participants.find(u => u !== currentUser);
                return other ? { ...acc, [id]: other } : acc;
            }, {} as Record<string, string>);

            return { roomIdToOtherUser: map };
        },
    },

    // Fetch the other participant's user document for each room
    {
        method: "branch",
        ref: "roomIdToOtherUser",
        explore: (store, map: Record<string, string>) =>
            Object.values(map).map(userId => ({
                method: "json_get", key: `user:${userId}`,
            })),
    },

    // Round-trip 3: flush user documents
    { method: "commit" },

    // Assemble the enriched room list
    {
        method: "windup",
        value: (store) => {
            const ids = store.get<string[]>("roomIds");
            const map = store.get<Record<string, string>>("roomIdToOtherUser");

            return ids.map(id => {
                const room = store.get<Room>(`room:${id}`);
                const userId = map[id];
                const user = store.get<User>(`user:${userId}`);
                return { ...room, participantName: user.name, participantAvatar: user.avatar };
            });
        },
    },
]);
```

---

## Configuration reference

| Option | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Logs each stage and pipeline result to `console.log`. |
| `timeoutInSeconds` | `number` | `10` | Throws if the entire aggregation exceeds this many seconds. |
| `signal` | `AbortSignal` | - | External cancellation signal. The aggregator checks before every stage. |
| `swallowPipelineErrors` | `boolean` | `false` | When `true`, failed pipeline commands produce `null` results instead of throwing. |
| `preserveArrayIndices` | `boolean` | `false` | Keep sparse array indices in RedisJSON responses instead of compacting them. |
| `pipelineResponseHandler` | `function` | - | Custom function to normalise your Redis driver's pipeline output. |

---

## Notes and gotchas

- **`branch` is not statically analysable.** `.explain()` will note it as dynamic and warn that the exact command count is unknown until runtime.
- **Stage keys must be globally unique per run.** If two stages would store their result under the same key (i.e. same `key` and no `storeAs`, or same `storeAs`), the pipeline throws a "Duplicate store key" error.
- **`commit` with an empty batch throws by default.** Set `allowEmptyBatch: true` on the `commit` stage if you have conditional branching that may produce no commands.
- **`transform` requires the key to already exist.** Use `derive` if you want to create a new store entry.