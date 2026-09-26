import { describe, expect, it } from "vitest";
import { Idempotency, MemoryStore } from "../src/index.js";

describe("lease reclaim (zombie)", () => {
  it("reclaims a processing key after the lease expires", async () => {
    let now = 1_000_000;
    const store = new MemoryStore();
    const idem = new Idempotency({
      store,
      leaseMs: 100,
      now: () => now,
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = idem.run(
      "zombie",
      { method: "POST", path: "/x", body: "{}" },
      async () => {
        await gate;
        return { statusCode: 200, body: "first" };
      },
    );

    await new Promise((r) => setTimeout(r, 5));
    now += 200;

    const second = await idem.run(
      "zombie",
      { method: "POST", path: "/x", body: "{}" },
      async () => ({ statusCode: 200, body: "reclaimed" }),
    );

    expect(second.replayed).toBe(false);
    expect(second.response.body).toBe("reclaimed");

    release();
    // First may still complete and try to write; abandon/complete race is ok.
    await first.catch(() => undefined);
  });
});

describe("concurrent claims", () => {
  it("only one of two parallel runs executes the handler", async () => {
    const idem = new Idempotency({ store: new MemoryStore() });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const work = () =>
      idem.run(
        "parallel",
        { method: "POST", path: "/x", body: "{}" },
        async () => {
          calls += 1;
          await gate;
          return { statusCode: 200, body: "ok" };
        },
      );

    const p1 = work();
    await new Promise((r) => setTimeout(r, 5));
    const p2 = work();

    await expect(p2).rejects.toMatchObject({ code: "in_progress" });
    release();
    await p1;
    expect(calls).toBe(1);
  });
});
