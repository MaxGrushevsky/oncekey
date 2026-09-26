# oncekey

Stripe-style `Idempotency-Key` for Node.js.

Retries and double-clicks should not create a second order or charge. `oncekey`
runs your handler once per key and replays the stored response.

Library only — no hosted service. You pick the store.

Repository: https://github.com/MaxGrushevsky/oncekey

Requires **Node 22+** (SQLite uses `node:sqlite`).

## Install

```bash
npm install oncekey
```

Optional peers depending on adapters/stores:

```bash
npm install pg ioredis express hono fastify koa
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

Useful options:

- `canonicalJson: true` — fingerprint ignores JSON key order
- `waitMs: 1000` — wait for an in-flight twin instead of immediate `409`

## Stores

| Store | Import | When |
|-------|--------|------|
| Memory | `oncekey` | tests, single process |
| SQLite | `oncekey/sqlite` | file on disk, no DB server |
| Postgres | `oncekey/postgres` | multi-instance (`pg`) |
| Redis | `oncekey/redis` | multi-instance (`ioredis`, Lua claim) |

```ts
import { SqliteStore } from "oncekey/sqlite";
import { PostgresStore } from "oncekey/postgres";
import { RedisStore } from "oncekey/redis";
```

## Adapters

| Adapter | Import |
|---------|--------|
| Fetch / Next.js | `protect` from `oncekey` |
| Express | `oncekey/express` |
| Hono | `oncekey/hono` |
| Fastify | `oncekey/fastify` |
| Koa | `oncekey/koa` |

### Next.js

```ts
import { Idempotency, protect } from "oncekey";
import { SqliteStore } from "oncekey/sqlite";

const idempotency = new Idempotency({
  store: new SqliteStore({ path: "data/oncekey.sqlite" }),
});

export const POST = protect(
  { idempotency, scope: () => "tenant" },
  async (request) => Response.json(await createOrder(request), { status: 201 }),
);
```

### Express

```ts
import { expressIdempotency } from "oncekey/express";

app.post(
  "/orders",
  express.json(),
  expressIdempotency({ idempotency })(async (req, res) => {
    res.status(201).json({ id: "ord_1" });
  }),
);
```

### Hono

```ts
import { honoIdempotency } from "oncekey/hono";

app.post("/orders", honoIdempotency({ idempotency }), async (c) =>
  c.json({ id: "ord_1" }, 201),
);
```

### Fastify

```ts
import { fastifyIdempotency } from "oncekey/fastify";

fastify.post(
  "/orders",
  fastifyIdempotency({ idempotency })(async (req, reply) =>
    reply.code(201).send({ id: "ord_1" }),
  ),
);
```

### Koa

```ts
import { koaIdempotency } from "oncekey/koa";

router.post("/orders", koaIdempotency({ idempotency }), async (ctx) => {
  ctx.status = 201;
  ctx.body = { id: "ord_1" };
});
```

## Behaviour

| Case | Result |
|------|--------|
| First request | Handler runs; response stored |
| Same key + same body | Replay; `Idempotent-Replay: true` |
| Same key + different body | `422 key_mismatch` |
| In flight | `409 in_progress` (or wait if `waitMs` set) |
| Handler throws / 5xx | Key abandoned; retry may run again |
| TTL (default 24h) | Key reusable after expiry |

Details: [docs/how-it-works.md](docs/how-it-works.md), [docs/stores.md](docs/stores.md), [docs/http.md](docs/http.md).

## Maturity

v0.2 — automated tests for core, stores (Memory/SQLite/Postgres fake/Redis mock), and adapters (Fetch/Express/Hono/Fastify/Koa). Live Postgres runs when `DATABASE_URL` is set. Use on staging before money paths.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
