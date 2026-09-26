# HTTP adapters

## Fetch — `protect` (`oncekey`)

For Next.js App Router and any `(Request) => Response` handler.

## Express — `expressIdempotency` (`oncekey/express`)

Wraps a single route handler (not a global `app.use` that calls `next()` into
unrelated routes).

Place after `express.json()` (or set `req.rawBody` / `getBody` for exact bytes).

Fingerprint default: `JSON.stringify(req.body)` after parsing. That means key
order in JSON objects matters for the hash. Prefer stable serialization or
`rawBody` if clients reshuffle keys.

## Hono — `honoIdempotency` (`oncekey/hono`)

Middleware. Reads a **clone** of the body for the fingerprint so
`c.req.json()` still works downstream.

## Shared error JSON

```json
{ "error": "missing_key" | "invalid_key" | "key_mismatch" | "in_progress", "message": "…" }
```

`in_progress` also sets `Retry-After`.
