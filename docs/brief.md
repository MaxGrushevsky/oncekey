# Brief

Public library: Stripe-style HTTP idempotency keys for Node.

## Goals

- Useful for orders, payments, webhook handlers
- Library only (no SaaS, no hosted DB of ours)
- Stores: Memory, SQLite, Postgres
- Adapters: Fetch, Express, Hono

## Honesty

The problem is real. The npm space is not empty (`idempotency-key`, `idem-key`,
and Express-specific packages already exist). `oncekey` aims for a clear API,
SQLite without a server, and first-class Fetch/Express/Hono adapters.

v0.1 is tested for the paths in `/test`. It is not a guarantee of zero bugs in
every production topology.
