import { describe, expect, it } from "vitest";
import { Idempotency, MemoryStore } from "../src/index.js";
import { SqliteStore } from "../src/sqlite.js";
import type { IdempotencyStore } from "../src/types.js";

function storeContract(name: string, create: () => IdempotencyStore | Promise<IdempotencyStore>, cleanup?: (s: IdempotencyStore) => void) {
  describe(`store contract: ${name}`, () => {
    it("acquires, completes, and replays", async () => {
      const store = await create();
      const idem = new Idempotency({ store });
      let calls = 0;
      const run = () =>
        idem.run(
          "c1",
          { method: "POST", path: "/x", body: "{}" },
          async () => {
            calls += 1;
            return { statusCode: 200, body: "ok" };
          },
        );
      expect((await run()).replayed).toBe(false);
      expect((await run()).replayed).toBe(true);
      expect(calls).toBe(1);
      cleanup?.(store);
    });

    it("mismatches on different body", async () => {
      const store = await create();
      const idem = new Idempotency({ store });
      await idem.run(
        "c2",
        { method: "POST", path: "/x", body: "a" },
        async () => ({ statusCode: 200, body: "1" }),
      );
      await expect(
        idem.run(
          "c2",
          { method: "POST", path: "/x", body: "b" },
          async () => ({ statusCode: 200, body: "2" }),
        ),
      ).rejects.toMatchObject({ code: "key_mismatch" });
      cleanup?.(store);
    });

    it("abandons on throw so retry works", async () => {
      const store = await create();
      const idem = new Idempotency({ store });
      await expect(
        idem.run(
          "c3",
          { method: "POST", path: "/x", body: "" },
          async () => {
            throw new Error("fail");
          },
        ),
      ).rejects.toThrow("fail");
      const ok = await idem.run(
        "c3",
        { method: "POST", path: "/x", body: "" },
        async () => ({ statusCode: 200, body: "recovered" }),
      );
      expect(ok.replayed).toBe(false);
      expect(ok.response.body).toBe("recovered");
      cleanup?.(store);
    });
  });
}

storeContract("MemoryStore", () => new MemoryStore());
storeContract(
  "SqliteStore",
  () => new SqliteStore({ path: ":memory:" }),
  (s) => (s as SqliteStore).close(),
);
