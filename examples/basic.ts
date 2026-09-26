/**
 * Minimal core usage.
 * npx tsx examples/basic.ts
 */

import { Idempotency, MemoryStore } from "../src/index.js";
import { SqliteStore } from "../src/sqlite.js";

const idem = new Idempotency({ store: new MemoryStore() });

async function createTwice() {
  const run = () =>
    idem.run(
      "demo-key-1",
      {
        method: "POST",
        path: "/orders",
        body: JSON.stringify({ sku: "mug", qty: 1 }),
      },
      async () => ({
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: { id: "ord_100", sku: "mug" },
      }),
      "user_42",
    );

  console.log("first", await run());
  console.log("second", await run());
}

async function sqliteDemo() {
  const store = new SqliteStore({ path: ":memory:" });
  const local = new Idempotency({ store });
  const result = await local.run(
    "demo-key-2",
    { method: "POST", path: "/orders", body: '{"sku":"mug"}' },
    async () => ({ statusCode: 201, body: '{"id":"ord_200"}' }),
  );
  console.log("sqlite", result);
  store.close();
}

await createTwice();
await sqliteDemo();
