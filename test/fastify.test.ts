import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Idempotency, MemoryStore } from "../src/index.js";
import { fastifyIdempotency } from "../src/fastify.js";

describe("fastifyIdempotency", () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (apps.length) {
      await apps.pop()!.close();
    }
  });

  it("replays JSON responses", async () => {
    const idempotency = new Idempotency({ store: new MemoryStore() });
    let calls = 0;
    const app = Fastify();
    apps.push(app);

    app.post(
      "/orders",
      fastifyIdempotency({ idempotency, scope: () => "t1" })(
        async (req, reply) => {
          calls += 1;
          const body = req.body as { sku: string };
          return reply.code(201).send({ id: "ord_1", sku: body.sku });
        },
      ),
    );

    await app.ready();

    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": "fk-1",
    };
    const payload = JSON.stringify({ sku: "mug" });

    const a = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload,
    });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(JSON.parse(b.body)).toEqual({ id: "ord_1", sku: "mug" });
    expect(calls).toBe(1);
  });
});
