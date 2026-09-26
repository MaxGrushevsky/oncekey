import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Idempotency } from "../src/index.js";
import { SqliteStore } from "../src/sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteStore", () => {
  it("persists replays on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    dirs.push(dir);
    const path = join(dir, "keys.sqlite");

    const store1 = new SqliteStore({ path });
    const idem1 = new Idempotency({ store: store1 });
    let calls = 0;

    await idem1.run(
      "disk-1",
      { method: "POST", path: "/orders", body: '{"n":1}' },
      async () => {
        calls += 1;
        return { statusCode: 201, body: '{"id":"o1"}' };
      },
    );
    store1.close();

    const store2 = new SqliteStore({ path });
    const idem2 = new Idempotency({ store: store2 });
    const replay = await idem2.run(
      "disk-1",
      { method: "POST", path: "/orders", body: '{"n":1}' },
      async () => {
        calls += 1;
        return { statusCode: 201, body: "should not run" };
      },
    );
    store2.close();

    expect(calls).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.response.body).toBe('{"id":"o1"}');
  });

  it("works with an in-memory database", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const idem = new Idempotency({ store });

    const first = await idem.run(
      "mem-1",
      { method: "POST", path: "/x", body: "" },
      async () => ({ statusCode: 200, body: "ok" }),
    );
    const second = await idem.run(
      "mem-1",
      { method: "POST", path: "/x", body: "" },
      async () => ({ statusCode: 200, body: "no" }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    store.close();
  });
});
