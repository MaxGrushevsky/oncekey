# Changelog

## 0.2.0

- Stores: Redis (`oncekey/redis`) with hash + Lua claim
- Adapters: Fastify (`oncekey/fastify`), Koa (`oncekey/koa`)
- Options: `canonicalJson`, `waitMs` / `waitPollMs`, `maxKeyLength`
- MemoryStore: per-key serialization
- Empty / whitespace Idempotency-Key → `missing_key`
- Shared store contract tests
- GitHub Actions CI (Node 22 + 24)

## 0.1.0

- Core `Idempotency.run`
- Memory + SQLite + Postgres stores
- Fetch `protect`, Express, Hono adapters
