import { afterEach, describe, expect, it } from "vitest";
import Redis from "ioredis-mock";
import { Idempotency } from "../src/index.js";
import { RedisStore } from "../src/redis.js";

describe("RedisStore", () => {
  const clients: Array<{ disconnect: () => void }> = [];
  afterEach(() => {
    while (clients.length) clients.pop()?.disconnect();
  });

  it("claims, completes, and replays via Lua", async () => {
    const redis = new Redis();
    clients.push(redis);
    const store = new RedisStore({ redis: redis as never });
    const idem = new Idempotency({ store });
    let calls = 0;

    const first = await idem.run(
      "r1",
      { method: "POST", path: "/x", body: "{}" },
      async () => {
        calls += 1;
        return { statusCode: 201, body: '{"ok":true}' };
      },
    );
    const second = await idem.run(
      "r1",
      { method: "POST", path: "/x", body: "{}" },
      async () => {
        calls += 1;
        return { statusCode: 201, body: "no" };
      },
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.response.body).toBe('{"ok":true}');
    expect(calls).toBe(1);
  });

  it("returns in_progress while leased", async () => {
    const redis = new Redis();
    clients.push(redis);
    const store = new RedisStore({ redis: redis as never });
    const idem = new Idempotency({ store, leaseMs: 10_000 });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = idem.run(
      "r2",
      { method: "POST", path: "/x", body: "{}" },
      async () => {
        await gate;
        return { statusCode: 200, body: "ok" };
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    await expect(
      idem.run(
        "r2",
        { method: "POST", path: "/x", body: "{}" },
        async () => ({ statusCode: 200, body: "no" }),
      ),
    ).rejects.toMatchObject({ code: "in_progress" });
    release();
    await first;
  });
});
