import { describe, expect, it } from "vitest";
import Koa from "koa";
import type { AddressInfo } from "node:net";
import { Idempotency, MemoryStore } from "../src/index.js";
import { koaIdempotency } from "../src/koa.js";

async function withServer(
  app: Koa,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("koaIdempotency", () => {
  it("replays when mounted on a route", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    let calls = 0;
    const app = new Koa();

    app.use(async (ctx, next) => {
      if (ctx.method === "POST" && ctx.path === "/orders") {
        // minimal JSON body parser
        const chunks: Buffer[] = [];
        for await (const chunk of ctx.req) {
          chunks.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        (ctx.request as { body?: unknown }).body = raw
          ? JSON.parse(raw)
          : {};
        (ctx.request as { rawBody?: string }).rawBody = raw;

        await koaIdempotency({
          idempotency,
          getBody: (c) =>
            (c.request as { rawBody?: string }).rawBody ??
            JSON.stringify(
              (c.request as { body?: unknown }).body ?? {},
            ),
        })(ctx, async () => {
          calls += 1;
          ctx.status = 201;
          ctx.body = { id: "ord_1" };
        });
        return;
      }
      await next();
    });

    await withServer(app, async (base) => {
      const headers = {
        "content-type": "application/json",
        "Idempotency-Key": "kk-1",
      };
      const body = JSON.stringify({ sku: "mug" });
      const a = await fetch(`${base}/orders`, {
        method: "POST",
        headers,
        body,
      });
      const b = await fetch(`${base}/orders`, {
        method: "POST",
        headers,
        body,
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers.get("Idempotent-Replay")).toBe("true");
      expect(await b.json()).toEqual({ id: "ord_1" });
      expect(calls).toBe(1);
    });
  });
});
