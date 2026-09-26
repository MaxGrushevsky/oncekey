# HTTP adapters

| Adapter | Import | Pattern |
|---------|--------|---------|
| Fetch | `protect` from `oncekey` | Next.js App Router |
| Express | `oncekey/express` | wrap one route handler |
| Hono | `oncekey/hono` | middleware |
| Fastify | `oncekey/fastify` | wrap one route handler |
| Koa | `oncekey/koa` | middleware |

Errors share JSON `{ error, message }`. `in_progress` sets `Retry-After`.

Express/Fastify/Koa fingerprint the parsed body by default (`JSON.stringify`).
Prefer raw body / `getBody` when clients reshuffle JSON keys, or enable
`canonicalJson` on `Idempotency`.
