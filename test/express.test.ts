import { afterEach, describe, expect, it } from "vitest";
import { Idempotency, MemoryStore } from "../src/index.js";
import { expressIdempotency } from "../src/express.js";
import express from "express";
import type { AddressInfo } from "node:net";

async function listen(app: express.Express): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("expressIdempotency", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it("replays a JSON handler", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    let calls = 0;
    const app = express();
    app.use(express.json());
    app.post(
      "/orders",
      expressIdempotency({
        idempotency,
        scope: () => "t1",
      })(async (req, res) => {
        calls += 1;
        res.status(201).json({ id: "ord_1", sku: req.body.sku });
      }),
    );

    const { base, close } = await listen(app);
    closers.push(close);

    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": "ek-1",
    };
    const body = JSON.stringify({ sku: "mug" });

    const a = await fetch(`${base}/orders`, { method: "POST", headers, body });
    const b = await fetch(`${base}/orders`, { method: "POST", headers, body });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replay")).toBe("true");
    expect(await b.json()).toEqual({ id: "ord_1", sku: "mug" });
    expect(calls).toBe(1);
  });

  it("returns 400 without a key", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    const app = express();
    app.use(express.json());
    app.post(
      "/orders",
      expressIdempotency({ idempotency })(async (_req, res) => {
        res.json({ ok: true });
      }),
    );
    const { base, close } = await listen(app);
    closers.push(close);

    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});
