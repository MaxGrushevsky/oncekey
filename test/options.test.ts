import { describe, expect, it } from "vitest";
import {
  Idempotency,
  MemoryStore,
  canonicalizeJson,
  fingerprint,
} from "../src/index.js";

describe("canonicalJson fingerprint", () => {
  it("treats reshuffled JSON keys as the same body", () => {
    const a = fingerprint(
      { method: "POST", path: "/o", body: '{"b":1,"a":2}' },
      { canonicalJson: true },
    );
    const b = fingerprint(
      { method: "POST", path: "/o", body: '{"a":2,"b":1}' },
      { canonicalJson: true },
    );
    expect(a).toBe(b);
  });

  it("canonicalizeJson sorts nested keys", () => {
    expect(canonicalizeJson({ z: 1, a: { c: 2, b: 3 } })).toEqual({
      a: { b: 3, c: 2 },
      z: 1,
    });
  });

  it("Idempotency with canonicalJson replays reshuffled bodies", async () => {
    const idem = new Idempotency({
      store: new MemoryStore(),
      canonicalJson: true,
    });
    let calls = 0;
    await idem.run(
      "k",
      { method: "POST", path: "/o", body: '{"b":1,"a":2}' },
      async () => {
        calls += 1;
        return { statusCode: 200, body: "x" };
      },
    );
    const second = await idem.run(
      "k",
      { method: "POST", path: "/o", body: '{"a":2,"b":1}' },
      async () => {
        calls += 1;
        return { statusCode: 200, body: "y" };
      },
    );
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("waitMs", () => {
  it("waits for an in-flight request and returns the replay", async () => {
    const idem = new Idempotency({
      store: new MemoryStore(),
      waitMs: 500,
      waitPollMs: 20,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = idem.run(
      "wait-1",
      { method: "POST", path: "/x", body: "{}" },
      async () => {
        await gate;
        return { statusCode: 200, body: "done" };
      },
    );

    await new Promise((r) => setTimeout(r, 20));
    const secondPromise = idem.run(
      "wait-1",
      { method: "POST", path: "/x", body: "{}" },
      async () => ({ statusCode: 200, body: "nope" }),
    );

    release();
    const [firstResult, secondResult] = await Promise.all([
      first,
      secondPromise,
    ]);
    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.response.body).toBe("done");
  });
});

describe("empty key", () => {
  it("treats whitespace-only key as missing", async () => {
    const idem = new Idempotency({ store: new MemoryStore() });
    await expect(
      idem.run("   ", { method: "POST", path: "/", body: "" }, async () => ({
        statusCode: 200,
        body: "x",
      })),
    ).rejects.toMatchObject({ code: "missing_key" });
  });
});
