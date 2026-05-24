# Redis JSON

A typed, atomic, rollback-proof API for the RedisJSON module.

---

## Why does this exist?

The official `@redis/json` package exposes raw Redis JSON commands with JSONPath syntax (`$.field1.field2`). That gets the job done, but it leaves a lot of work to the developer:

- **JSONPath strings are error-prone and untyped.** Typos compile silently. There's no TypeScript autocomplete for `"$.user.profile.address.city"`.
- **Updating multiple fields requires multiple commands.** There's no atomic "update these five fields at once" operation - you fire five separate commands and hope nothing goes wrong between them.
- **No rollback.** If the third of five commands fails, the first two have already been applied. Your document is in a half-mutated state.
- **No `pick`.** Getting a subset of fields requires either fetching the whole document and slicing in application code, or writing multiple `JSON.GET` calls.

`RedisJson` was built to solve all four:

1. **TypeScript-native paths.** Pass `{ user: { name: true, email: true } }` instead of `"$.user.name", "$.user.email"`. The type system knows which fields exist, which are arrays, and which are booleans.
2. **Atomic multi-field mutations.** `update`, `patch`, `del`, and all array/number/string methods compile down to a single server-side Lua script that validates fields first and then mutates. Either everything succeeds or nothing changes.
3. **Automatic rollback.** The script uses a **snapshot-and-rollback** strategy to guarantee atomicity. If any error was recorded, the script restores the document to the snapshot.
4. **`pick` and `get`.** Fetch the whole document with `get`, or only the fields you need with `pick` - both use `JSON.GET` under the hood with the exact set of paths your code requests.

---

## Installation

```bash
npm install @redis-flow/json
```

---

## Quick start

```ts
import { RedisJson } from "@redis-flow/json";

const json = new RedisJson(redis);

type User = {
  name: string;
  age: number;
  email: string;
  tags: string[];
  isActive: boolean;
};

// Create a document
await json.set<User>("user:1", {
  name: "Alice",
  age: 30,
  email: "alice@example.com",
  tags: ["beta"],
  isActive: true,
});

// Read the full document
const user = await json.get<User>("user:1");

// Read specific fields
const partial = await json.pick<User>("user:1", {
  name: true,
  age: true,
});

// Update multiple fields atomically
await json.update("user:1", {
  name: "Alice Smith",
  age: 31,
});

// Complex multi-operation patch - all atomic
await json.patch("user:1", {
  $set: { email: "alice.smith@example.com" },
  $toggle: { isActive: true },
  $number: { $inc_by: { age: 1 } },
  $array: { $append: { tags: ["premium"] } },
});
```

---

## Dual-mode: standard vs pipeline

`RedisJson` detects whether you pass a plain Redis instance or a pipeline instance at construction time, and changes its behaviour accordingly.

### Standard mode (`Redis` instance)

All mutation methods use the atomic Lua script - every call is a single `EVALSHA` round-trip that validates, mutates, and optionally returns a document snapshot.

```ts
const json = new RedisJson(redis);

const result = await json.update("user:1", { name: "Bob" });
// result: { name: "OK" }
```

### Pipeline mode (`redis.pipeline()`)

Methods queue `JSON.*` commands onto the pipeline. No Redis calls are made until you call `.exec()`. Use this when you need to batch multiple document operations alongside other Redis commands.

```ts
const pipeline = redis.pipeline();
const json = new RedisJson(pipeline);

json.get("user:1");
json.get("user:2");
json.get("user:3");

const [user1, user2, user3] = await json.exec();
```

> **Note:** In pipeline mode, mutation methods do **not** use the atomic Lua script - they queue individual `JSON.*` commands. Atomicity across a pipeline cannot be guaranteed at the library level.

---

## Path syntax

All methods accept a `FieldPath` which can be expressed as:

### String (raw Redis JSON path)

Passed through verbatim.

```ts
json.pick("key", "$.user.name");
```

### String array

Each string is treated as a separate path.

```ts
json.pick("key", ["$.user.name", "$.user.email"]);
```

### Path object (recommended)

The most expressive and type-safe form. Nested keys mirror the document shape.

```ts
// Pick specific fields
json.pick<User>("key", {
  name: true,
  email: true,
  address: { city: true },
});
```

**Array indexing with `$index`:**

```ts
// Pick first and third favourite game
json.pick("key", {
  fav_games: { $index: [0, 2] },
});

// Pick index 1 of a nested array
json.pick("key", {
  hobbies: {
    indoor: { $index: 1 },
  },
});
```

**Deep traversal with `$path`:**

```ts
// Equivalent to $.someField[0][2]
json.pick("key", {
  someField: { $path: [0, 2] },
});

// Multi-path traversal (array-of-arrays)
json.pick("key", {
  hobbies: {
    indoor: { $path: [[0], [1], [2]] },
  },
});
```

---

## API reference

### Read methods

---

#### `json.get<T>(key)`

Fetches the full JSON document at `key`.

```ts
const user = await json.get<User>("user:1");
```

Returns `Promise<T>` in standard mode, `this` in pipeline mode.

---

#### `json.pick<T>(key, path, config?)`

Fetches one or more specific fields from a document. More efficient than `get` for large documents because only the requested fields are transferred.

```ts
const partial = await json.pick<User>("user:1", {
  name: true,
  tags: { $index: 0 },
});
// -> { name: "Alice", tags: ["beta"] }
```

---

#### `json.type(key, path?, config?)`

Returns the RedisJSON type of one or more fields, or the whole document.

Possible values: `"string"` | `"integer"` | `"number"` | `"boolean"` | `"object"` | `"array"` | `"null"`.

Returns `null` per-field when the field does not exist, or `null` when the key does not exist.

```ts
await json.type("user:1", { name: true, age: true });
// -> { name: "string", age: "integer" }

await json.type("nonexistent");
// -> null
```

---

#### `json.strLen(key, path, config?)`

Returns the character length of one or more string fields.

**Only works on `string` fields.** Returns `null` per-field when the key doesn't exist.

```ts
await json.strLen("user:1", { name: true });
// -> { name: 5 }
```

---

#### `json.objLen(key, path?, config?)`

Returns the number of top-level keys in one or more object fields, or the whole document.

**Only works on `object` fields.** Returns `null` per-field when the field doesn't exist.

```ts
await json.objLen("user:1", "address");
// -> { address: 3 }

await json.objLen("user:1"); // whole document
// -> 5
```

---

#### `json.objKeys(key, path?, config?)`

Returns the top-level key names of one or more object fields.

```ts
await json.objKeys("user:1", "address");
// -> { address: ["street", "city", "country"] }
```

---

### Write methods

All write methods:

- Return `Promise<...>` in standard mode or `this` in pipeline mode.
- Accept an optional third `option` argument.
- Support `option.returns: "mutated document"` to get the full document after mutation (no extra round-trip).
- Support `option.returns: "non mutated document"` to get the full document before mutation (useful for optimistic locking).

---

#### `json.set<T>(key, value, option?)`

Creates or fully replaces a JSON document. Any existing document at `key` is overwritten.

```ts
await json.set("user:1", {
  name: "Alice",
  age: 30,
  isActive: true,
});
// -> "OK"

// Get the stored document back in one call
const doc = await json.set(
  "user:1",
  { name: "Alice", age: 30 },
  {
    returns: "mutated document",
  },
);
// -> { name: "Alice", age: 30 }
```

---

#### `json.update(key, value, option?)`

Updates one or more specific fields of an existing document. Fields not mentioned in `value` are untouched.

`value` uses the path object syntax where **the leaf value is the new value to write** (not `true`).

```ts
// doc: { name: "Alice", age: 30, status: "inactive" }
await json.update("user:1", {
  status: "active",
  age: 31,
});
// doc: { name: "Alice", age: 31, status: "active" }
```

Nested updates:

```ts
await json.update("user:1", {
  address: { city: "London" },
});
```

---

#### `json.merge<T>(key, value, option?)`

Deep-merges a plain object into the document root. Existing keys are overwritten, new keys are added, and absent keys are left untouched. To remove keys, combine `merge` with `del`.

```ts
// doc: { name: "Alice", role: "user" }
await json.merge("user:1", { role: "admin", verified: true });
// doc: { name: "Alice", role: "admin", verified: true }
```

---

#### `json.patch(key, value, option?)`

The most expressive write method. Bundles multiple field-level operations into a **single atomic call**. All operations are validated then applied, or none are applied.

```ts
await json.patch<User>("user:1", {
  // Set field values
  $set: {
    email: "new@example.com",
  },

  // Append to string fields
  $appendInString: {
    name: " Jr.",
  },

  // Flip boolean fields
  $toggle: {
    isActive: true,
  },

  // Numeric operations
  $number: {
    $inc_by: { age: 1 }, // increment
    $mul_by: { score: 2 }, // multiply
  },

  // Array operations
  $array: {
    $append: { tags: ["verified"] },
    $insert: { fav_games: { $index: 0, $value: "Chess" } },
    $trim: { recentActivity: { $index: 0, $value: [0, 19] } }, // keep first 20
    $pop: { notifications: true }, // remove last element
  },
});
```

**`$patch` operation keys:**

| Key               | Effect                                                   |
| ----------------- | -------------------------------------------------------- |
| `$set`            | Set field values (same as `update`)                      |
| `$merge`          | Deep-merge an object into an existing object field       |
| `$toggle`         | Flip boolean fields                                      |
| `$appendInString` | Append a string fragment to string fields                |
| `$array.$append`  | Push elements to the end of array fields                 |
| `$array.$insert`  | Insert elements at a specific index in array fields      |
| `$array.$trim`    | Trim array fields to a `[start, stop]` range (inclusive) |
| `$array.$pop`     | Remove and return the last element |
| `$number.$inc_by` | Increment numeric fields                                 |
| `$number.$mul_by` | Multiply numeric fields                                  |

---

#### `json.del(key, path?, option?)`

Deletes one or more fields. Pass `undefined` to delete the entire document key.

```ts
// Delete specific fields
await json.del<User>("user:1", { tempToken: true, resetCode: true });

// Delete the entire document
await json.del("user:1");
```

---

#### `json.strAppend(key, value, option?)`

Appends a string fragment to the end of one or more string fields. No whitespace is inserted automatically.

```ts
// doc: { name: "Alex" }
await json.strAppend("user:1", { name: " Costa" });
// doc: { name: "Alex Costa" }
```

---

#### `json.numIncrBy(key, value, option?)`

Increments one or more numeric fields by a specified delta. Use a negative value to decrement.

```ts
// doc: { loginCount: 5, score: 100 }
await json.numIncrBy("user:1", { loginCount: 1, score: -10 });
// doc: { loginCount: 6, score: 90 }
```

---

#### `json.numMultBy(key, value, option?)`

Multiplies one or more numeric fields by a specified factor.

```ts
// doc: { price: 10.0 }
await json.numMultBy("item:1", { price: 1.2 }); // 20% markup
// doc: { price: 12.0 }
```

---

#### `json.arrAppend(key, value, option?)`

Appends one or more elements to the end of array fields.

```ts
// doc: { tags: ["typescript"] }
await json.arrAppend("post:1", { tags: ["redis", "backend"] });
// doc: { tags: ["typescript", "redis", "backend"] }
```

---

#### `json.arrInsert(key, value, option?)`

Inserts one or more elements before a specific index.

```ts
// doc: { fav_games: ["GTA", "COD"] }
await json.arrInsert("user:1", {
  fav_games: { $index: 1, $value: "Fortnite" },
});
// doc: { fav_games: ["GTA", "Fortnite", "COD"] }
```

Negative indices count from the end. `-1` inserts before the last element:

```ts
await json.arrInsert("user:1", {
  fav_games: { $index: -1, $value: "Minecraft" },
});
// doc: { fav_games: ["GTA", "Fortnite", "Minecraft", "COD"] }
```

To append at the very end, use `arrAppend` instead.

---

#### `json.arrTrim(key, value, option?)`

Retains only the elements from `start` to `stop` (both inclusive). Elements outside this range are permanently removed.

```ts
// doc: { recent: ["a", "b", "c", "d", "e"] }
await json.arrTrim("user:1", { recent: [1, 3] });
// doc: { recent: ["b", "c", "d"] }

// Keep only the first 20 elements (indexes 0–19)
await json.arrTrim("user:1", { history: [0, 19] });
```

---

#### `json.arrPop(key, value, option?)`

Removes and returns the element at a specified index (default: last element).

```ts
// doc: { notifications: ["msg1", "msg2", "msg3"] }
await json.arrPop("user:1", { notifications: true });
// -> { notifications: "msg3" }
// doc: { notifications: ["msg1", "msg2"] }
```

---

#### `json.toggle(key, value, option?)`

Flips one or more boolean fields.

```ts
// doc: { isActive: true, isDarkMode: false }
await json.toggle("user:1", { isActive: true, isDarkMode: true });
// doc: { isActive: false, isDarkMode: true }
```

---

### `json.exec()`

Flushes the pipeline queue (pipeline mode only) and returns all results as a parsed array.

```ts
const pipeline = redis.pipeline();
const json = new RedisJson(pipeline);

json.get("user:1");
json.get("user:2");

const [user1, user2] = await json.exec();
```

---

## Configuration

```ts
const json = new RedisJson(redis, {
  debug: false,
  pipelineResponseHandler: (rawResult) => {
    // Custom normaliser for non-ioredis drivers
    return rawResult.map((r) => r[1]);
  },
});
```

| Option                    | Type       | Default | Description                                                              |
| ------------------------- | ---------- | ------- | ------------------------------------------------------------------------ |
| `debug`                   | `boolean`  | `false` | Logs each operation and its timing to `console.log`.                     |
| `pipelineResponseHandler` | `function` | -       | Custom function to normalise your Redis driver's pipeline output format. |

The optional third argument to accessor methods also accepts:

| Option                 | Type      | Default | Description                                                        |
| ---------------------- | --------- | ------- | ------------------------------------------------------------------ |
| `preserveArrayIndices` | `boolean` | `false` | Keep sparse array indices in responses instead of compacting them. |

---

## Atomicity and the Lua script

Every write call in standard mode compiles down to a single `EVALSHA` call against a server-side Lua script. The script uses a **snapshot-and-rollback** strategy to guarantee atomicity:

1. **Snapshot.** Before any operation runs, the script captures the full current document with `JSON.GET`.
2. **Execute with inline validation.** Operations are processed one by one in order. Each operation validates its precondition (type check, path existence) and - if the check passes - executes immediately. If a validation fails, the error is recorded and all remaining executions are skipped.
3. **Rollback on error.** If any error was recorded, the script restores the document to the pre-run snapshot and returns the error list. If the document did not exist before the batch ran, it is deleted instead of restored.
4. **Return.** On success, the script returns either the per-operation results, the post-mutation document, or the pre-mutation snapshot - depending on `resultMode`.

This means:
- **No partial mutations.** The moment any operation fails, the snapshot is restored. The document is always either fully updated or completely unchanged.
- **Sequential type awareness.** Because validation and execution are interleaved rather than separated into two phases, an earlier operation in the same batch can create or change a field that a later operation then validates against.
- **No extra round-trips.** Snapshot, mutation, optional document return, and rollback all happen inside one server-side script execution.

### Operations that modify type are immediately visible to later operations

The script invalidates its internal type cache whenever a `set` or `del` operation runs. This means later operations in the same batch always validate against the **post-mutation** state of the document, not the pre-batch state.

```ts
// ✅ Works - by the time arrappend validates .arr, the preceding set has already run
// and the type cache has been invalidated, so .arr is correctly seen as an array.
await json.patch("doc", {
    $set:   { arr: [] },
    $array: { $append: { arr: ["first"] } },
});
```

### Rollback behaviour

If the document existed before the batch, it is restored to its pre-batch state on error:

```ts
// doc: { count: 5, label: "hello" }

// ❌ numincrby will fail because "label" is a string, not a number.
// "count" has already been incremented to 6 when the error occurs -
// but the snapshot restores the document to { count: 5, label: "hello" }.
await json.patch("doc", {
    $number: {
        $inc_by: { count: 1, label: 1 },
    },
});
```

If the document **did not exist** before the batch, the script deletes any partially-created state instead of restoring it, leaving Redis as if the call never happened.

### What can still fail

Snapshot-based rollback protects against **logical errors** (wrong type, missing path). It does not protect against Redis infrastructure failures mid-script (e.g. a server crash between two `JSON.SET` calls inside the script). For the vast majority of production workloads this distinction does not matter, but it is worth noting if you are designing around strict durability guarantees.

### Script caching

The Lua script SHA is cached per Redis instance. The `SCRIPT LOAD` round-trip happens only once per connection. If Redis evicts the script (server restart, `SCRIPT FLUSH`), it is reloaded automatically with up to 3 retries.

---

## vs `@redis/json`

| Feature                               | `@redis/json` | `RedisJson`      |
| ------------------------------------- | ------------- | ---------------- |
| TypeScript path autocomplete          | ❌            | ✅               |
| Atomic multi-field mutations          | ❌            | ✅               |
| Automatic rollback on error           | ❌            | ✅               |
| `pick` (partial document fetch)       | ❌            | ✅               |
| `patch` (multi-operation in one call) | ❌            | ✅               |
| Pipeline mode                         | ✅            | ✅               |
| Driver-agnostic                       | ❌            | ✅               |
| Edge environment support              | ❌            | ✅               |
| JSONPath string paths                 | ✅            | ✅ (passthrough) |
