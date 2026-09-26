import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Idempotency, MemoryStore } from "../src/index.js";
import { honoIdempotency } from "../src/hono.js";

describe("honoIdempotency", () => {
  it("replays JSON responses", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    let calls = 0;
    const app = new Hono();
    app.post(
      "/orders",
      honoIdempotency({ idempotency, scope: () => "t1" }),
      async (c) => {
        calls += 1;
        const body = await c.req.json<{ sku: string }>();
        return c.json({ id: "ord_1", sku: body.sku }, 201);
      },
    );

    const req = () =>
      new Request("http://localhost/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "hk-1",
        },
        body: JSON.stringify({ sku: "mug" }),
      });

    const a = await app.request(req());
    const b = await app.request(req());

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replay")).toBe("true");
    expect(await b.json()).toEqual({ id: "ord_1", sku: "mug" });
    expect(calls).toBe(1);
  });
});
