# How it works

## The problem

HTTP clients retry. Mobile networks drop. Users double-click "Pay".

Your route does something that must happen once:

- insert an order row
- call a payment provider
- mark a webhook event as processed

If the handler runs twice, you get duplicate side effects. Idempotency keys
exist so the *server* can notice "I already did this" and return the original
outcome.

The pattern matches what Stripe documented and what the IETF draft for the
`Idempotency-Key` header describes. `oncekey` is a Node implementation of that
contract.


## Lifecycle of a key

1. Client generates a key (UUID is fine) for one logical attempt.
2. Client sends it on every retry of that attempt:
   `Idempotency-Key: …`
3. Server builds a **storage key** = `scope` + raw key.  
   Scope is usually a tenant or user id so two customers never share a key
   namespace.
4. Server hashes a **fingerprint** of method + path + body (+ optional extra).
5. Store **claim**:
   - no row → mark `processing`, run handler
   - completed + same fingerprint → return stored response
   - same key + different fingerprint → `422`
   - `processing` and lease still valid → `409`
   - `processing` but lease expired (process died) → reclaim and run again
6. On success with a storeable status → save response as `completed`.
7. On throw or non-storeable status (default: 5xx) → delete the processing
   row so a retry can try again.

## Why the fingerprint exists

Without it, a client could send key `K` with body `{amount:10}`, then reuse
`K` with `{amount:10000}` and get the first response — or worse, confuse your
ops. Mismatch is a hard error (`422`).

## Why the lease exists

Two concurrent requests with the same key must not both run the handler.
The first claim wins and holds a lease (`leaseMs`, default 60s). Others get
`409` until the first completes or the lease times out.

If the process crashes mid-handler, the row stays `processing`. After the
lease expires, another worker may reclaim the key. That is at-least-once for
crash recovery: design the handler so a second run after a crash is safe
(unique constraints, upserts, or provider-side idempotency).

## What gets stored

For a completed request we keep:

- status code
- a filtered set of response headers (never `authorization` / `set-cookie`)
- body as text (objects are JSON-stringified)

Clients that need typed JSON parse the body themselves.

## TTL

Completed rows expire after `ttlMs` (default 24 hours). After expiry the key
may be used again for a new operation. Shorten TTL if you store large bodies;
lengthen it if clients retry over long windows.

## Failure modes worth knowing

**Handler returns 503**  
By default we do not store 5xx. A retry runs the handler again. That is
usually what you want for transient errors.

**Handler returns 400**  
Stored and replayed. A retry with the same key will not "fix" validation
by changing the body — that becomes `422` mismatch. To change input, use a
new key.

**Two tabs, two keys**  
Idempotency does not merge intentional duplicate submissions. The product UX
should reuse one key per "Pay" attempt (generate on page load or on first
click, reuse on retry).

**Shared MemoryStore across serverless instances**  
Each instance has its own memory. Use SQLite (careful with serverless FS) or
a remote store.

## Relation to webhooks

For *incoming* webhooks, prefer the provider's event id as the key (for
example Stripe `event.id`) and a fingerprint of the payload. That way a
redelivered event does not run your side effects twice.
