# Stores

`oncekey` never hosts your keys. You pass a store.

## MemoryStore

```ts
import { MemoryStore } from "oncekey";
```

Single process only. Lost on restart.

## SqliteStore

```ts
import { SqliteStore } from "oncekey/sqlite";

const store = new SqliteStore({ path: "data/oncekey.sqlite" });
```

Node 22+ (`node:sqlite`). No separate database server.

## PostgresStore

```ts
import pg from "pg";
import { PostgresStore } from "oncekey/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresStore({ pool });
await store.ready();
```

Uses a transaction + `FOR UPDATE` on claim so concurrent workers do not both
run the handler. Install `pg` yourself (optional peer dependency).

## Custom

Implement `IdempotencyStore` (`claim` / `complete` / `abandon` / `get`).
`claim` must be atomic under concurrency.
