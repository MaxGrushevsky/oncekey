import { describe, expect, it } from "vitest";
import { Idempotency, MemoryStore, protect } from "../src/index.js";

describe("protect", () => {
  it("wraps a fetch handler and replays", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    let calls = 0;

    const handler = protect(
      { idempotency, scope: () => "acct_1" },
      async () => {
        calls += 1;
        return Response.json({ id: "ord_1" }, { status: 201 });
      },
    );

    const req = () =>
      new Request("http://localhost/api/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "k1",
        },
        body: JSON.stringify({ sku: "mug" }),
      });

    const a = await handler(req());
    const b = await handler(req());

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replay")).toBe("true");
    expect(await b.json()).toEqual({ id: "ord_1" });
    expect(calls).toBe(1);
  });

  it("returns 400 when the key is missing and required", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    const handler = protect({ idempotency }, async () =>
      Response.json({ ok: true }),
    );

    const res = await handler(
      new Request("http://localhost/api/orders", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("missing_key");
  });
});
