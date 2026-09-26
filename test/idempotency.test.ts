import { describe, expect, it } from "vitest";
import {
  Idempotency,
  InProgressError,
  KeyMismatchError,
  MemoryStore,
  MissingKeyError,
  fingerprint,
} from "../src/index.js";

function orderHandler(id: string) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async () => {
      calls += 1;
      return {
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: { id, calls },
      };
    },
  };
}

describe("fingerprint", () => {
  it("is stable for the same input", () => {
    const a = fingerprint({
      method: "post",
      path: "/orders/",
      body: '{"a":1}',
    });
    const b = fingerprint({
      method: "POST",
      path: "/orders",
      body: '{"a":1}',
    });
    expect(a).toBe(b);
  });

  it("changes when the body changes", () => {
    const a = fingerprint({ method: "POST", path: "/orders", body: "1" });
    const b = fingerprint({ method: "POST", path: "/orders", body: "2" });
    expect(a).not.toBe(b);
  });
});

describe("Idempotency + MemoryStore", () => {
  it("runs the handler once and replays later", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store });
    const handler = orderHandler("ord_1");

    const first = await idem.run(
      "key-1",
      { method: "POST", path: "/orders", body: '{"sku":"a"}' },
      handler.run,
      "tenant_a",
    );
    const second = await idem.run(
      "key-1",
      { method: "POST", path: "/orders", body: '{"sku":"a"}' },
      handler.run,
      "tenant_a",
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.response.body).toBe(first.response.body);
    expect(handler.calls).toBe(1);
  });

  it("rejects the same key with a different body", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store });
    const handler = orderHandler("ord_2");

    await idem.run(
      "key-2",
      { method: "POST", path: "/orders", body: '{"sku":"a"}' },
      handler.run,
    );

    await expect(
      idem.run(
        "key-2",
        { method: "POST", path: "/orders", body: '{"sku":"b"}' },
        handler.run,
      ),
    ).rejects.toBeInstanceOf(KeyMismatchError);
    expect(handler.calls).toBe(1);
  });

  it("requires a key", async () => {
    const idem = new Idempotency({ store: new MemoryStore() });
    await expect(
      idem.run(null, { method: "POST", path: "/", body: "" }, async () => ({
        statusCode: 200,
        body: "ok",
      })),
    ).rejects.toBeInstanceOf(MissingKeyError);
  });

  it("isolates keys by scope", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store });
    const a = orderHandler("a");
    const b = orderHandler("b");

    await idem.run(
      "shared",
      { method: "POST", path: "/orders", body: "{}" },
      a.run,
      "t1",
    );
    await idem.run(
      "shared",
      { method: "POST", path: "/orders", body: "{}" },
      b.run,
      "t2",
    );

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  it("returns in_progress while the first request holds the lease", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store, leaseMs: 10_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = idem.run(
      "key-slow",
      { method: "POST", path: "/pay", body: "{}" },
      async () => {
        await gate;
        return { statusCode: 200, body: '{"ok":true}' };
      },
    );

    // Let the first claim settle.
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      idem.run(
        "key-slow",
        { method: "POST", path: "/pay", body: "{}" },
        async () => ({ statusCode: 200, body: "nope" }),
      ),
    ).rejects.toBeInstanceOf(InProgressError);

    release();
    const done = await slow;
    expect(done.replayed).toBe(false);
    expect(done.response.body).toBe('{"ok":true}');
  });

  it("does not store 5xx responses for replay", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store });
    let calls = 0;

    await idem.run(
      "key-5xx",
      { method: "POST", path: "/pay", body: "{}" },
      async () => {
        calls += 1;
        return { statusCode: 503, body: "busy" };
      },
    );

    const second = await idem.run(
      "key-5xx",
      { method: "POST", path: "/pay", body: "{}" },
      async () => {
        calls += 1;
        return { statusCode: 200, body: "ok" };
      },
    );

    expect(calls).toBe(2);
    expect(second.replayed).toBe(false);
    expect(second.response.statusCode).toBe(200);
  });

  it("abandons the key when the handler throws", async () => {
    const store = new MemoryStore();
    const idem = new Idempotency({ store });

    await expect(
      idem.run(
        "key-throw",
        { method: "POST", path: "/pay", body: "{}" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const retry = await idem.run(
      "key-throw",
      { method: "POST", path: "/pay", body: "{}" },
      async () => ({ statusCode: 200, body: "recovered" }),
    );
    expect(retry.replayed).toBe(false);
    expect(retry.response.body).toBe("recovered");
  });
});
