# Stores

| Store | Package path | Notes |
|-------|--------------|-------|
| MemoryStore | `oncekey` | Single process |
| SqliteStore | `oncekey/sqlite` | Node 22+ `node:sqlite` |
| PostgresStore | `oncekey/postgres` | `pg` peer; `FOR UPDATE` claims |
| RedisStore | `oncekey/redis` | `ioredis` peer; Lua claim/complete/abandon |

Custom stores implement `IdempotencyStore`.
