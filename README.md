# oncekey

Stripe-style `Idempotency-Key` for Node.js.

If a client retries a POST, your handler should not create a second order or
charge twice. `oncekey` stores the first response under the key and returns it
again.

This is a library, not a hosted service. Keys live in a store you choose.

**Package name:** `oncekey` (the npm name `idempotency-key` is already taken by
another project with a similar goal).

Requires Node 22+ for the SQLite adapter (`node:sqlite`). Core + Memory + HTTP
adapters work on Node 20+ if you skip SQLite.

## Install

```bash
npm install oncekey

# optional, depending on what you use:
npm install pg          # Postgres store
npm install express     # Express adapter
npm install hono        # Hono adapter
```

## Quick start

```ts
import { Idempotency, MemoryStore } from "oncekey";

const idem = new Idempotency({ store: new MemoryStore() });

const result = await idem.run(
  request.headers.get("Idempotency-Key"),
  { method: "POST", path: "/orders", body: rawBody },
  async () => {
    const order = await db.orders.create(JSON.parse(rawBody));
    return { statusCode: 201, body: order };
  },
  "tenant_123",
);
```

## Stores

| Store | Import | Notes |
|-------|--------|--------|
| Memory | `oncekey` | Tests / single process |
| SQLite file | `oncekey/sqlite` | No DB server; Node 22+ |
| Postgres | `oncekey/postgres` | Multi-instance; needs `pg` |
| Custom | implement `IdempotencyStore` | Redis, etc. |

```ts
import { SqliteStore } from "oncekey/sqlite";
import { PostgresStore } from "oncekey/postgres";
import pg from "pg";

const sqlite = new SqliteStore({ path: "data/oncekey.sqlite" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const postgres = new PostgresStore({ pool });
await postgres.ready();
```

## HTTP adapters

| Adapter | Import | Fits |
|---------|--------|------|
| Fetch `protect` | `oncekey` | Next.js App Router, plain Request/Response |
| Express | `oncekey/express` | Express 4/5 route handlers |
| Hono | `oncekey/hono` | Hono middleware |

### Next.js / Fetch

```ts
import { Idempotency, protect } from "oncekey";
import { SqliteStore } from "oncekey/sqlite";

const idempotency = new Idempotency({
  store: new SqliteStore({ path: "data/oncekey.sqlite" }),
});

export const POST = protect(
  { idempotency, scope: () => "tenant" },
  async (request) => {
    const body = await request.json();
    return Response.json({ id: "ord_1", ...body }, { status: 201 });
  },
);
```

### Express

```ts
import express from "express";
import { Idempotency, MemoryStore } from "oncekey";
import { expressIdempotency } from "oncekey/express";

const idempotency = new Idempotency({ store: new MemoryStore() });
const app = express();
app.use(express.json());

app.post(
  "/orders",
  expressIdempotency({ idempotency, scope: (req) => req.header("x-tenant") ?? "" })(
    async (req, res) => {
      res.status(201).json({ id: "ord_1", sku: req.body.sku });
    },
  ),
);
```

### Hono

```ts
import { Hono } from "hono";
import { Idempotency, MemoryStore } from "oncekey";
import { honoIdempotency } from "oncekey/hono";

const idempotency = new Idempotency({ store: new MemoryStore() });
const app = new Hono();

app.post(
  "/orders",
  honoIdempotency({ idempotency }),
  async (c) => c.json({ id: "ord_1" }, 201),
);
```

## Behaviour (short)

| Case | Result |
|------|--------|
| First request | Handler runs; response stored |
| Same key + same body | Replay; `Idempotent-Replay: true` |
| Same key + different body | `422 key_mismatch` |
| In flight | `409 in_progress` |
| Handler throws / 5xx | Key abandoned; retry may run again |
| TTL (default 24h) | Key may be reused after expiry |

More detail: [docs/how-it-works.md](docs/how-it-works.md).

## Maturity

v0.1. Automated tests cover core semantics, SQLite, Express, Hono, concurrency,
and a fake Postgres driver. A live Postgres test runs only when `DATABASE_URL`
is set. This is useful and working for the covered paths — it is not a claim of
production battle-testing at Stripe scale. Read the docs, run the tests, try it
on a staging route before relying on it for money movement.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
