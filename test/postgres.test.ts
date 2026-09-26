import { describe, expect, it } from "vitest";
import { PostgresStore } from "../src/postgres.js";
import { Idempotency } from "../src/index.js";

/**
 * Lightweight fake Pool that supports the queries PostgresStore issues.
 * Full integration against a real Postgres is optional via DATABASE_URL.
 */
function createFakePool() {
  const rows = new Map<string, Record<string, unknown>>();

  const client = {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith("DELETE FROM") && normalized.includes("expires_at")) {
        const key = params[0] as string;
        const now = params[1] as number;
        const row = rows.get(key);
        if (row && (row.expires_at as number) <= now) rows.delete(key);
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith("DELETE FROM") && normalized.includes("status = 'processing'")) {
        const key = params[0] as string;
        const fp = params[1] as string;
        const row = rows.get(key);
        if (row && row.fingerprint === fp && row.status === "processing") {
          rows.delete(key);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.includes("FOR UPDATE")) {
        const key = params[0] as string;
        const row = rows.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (normalized.startsWith("INSERT INTO")) {
        const [storage_key, fingerprint, now, expires_at] = params as [
          string,
          string,
          number,
          number,
        ];
        rows.set(storage_key, {
          storage_key,
          fingerprint,
          status: "processing",
          response_json: null,
          locked_at: now,
          created_at: now,
          updated_at: now,
          expires_at,
        });
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE") && normalized.includes("completed")) {
        const [storage_key, fingerprint, response_json, now, expires_at] =
          params as [string, string, string, number, number];
        const row = rows.get(storage_key);
        if (row && row.fingerprint === fingerprint && row.status === "processing") {
          row.status = "completed";
          row.response_json = JSON.parse(response_json);
          row.updated_at = now;
          row.locked_at = now;
          row.expires_at = expires_at;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith("UPDATE") && normalized.includes("processing")) {
        const [storage_key, fingerprint, now, expires_at] = params as [
          string,
          string,
          number,
          number,
        ];
        const row = rows.get(storage_key);
        if (row) {
          row.fingerprint = fingerprint;
          row.status = "processing";
          row.response_json = null;
          row.locked_at = now;
          row.updated_at = now;
          row.expires_at = expires_at;
        }
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("CREATE INDEX")) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unhandled SQL in fake pool: ${normalized}`);
    },
    release() {},
  };

  return {
    async connect() {
      return client;
    },
    async query(sql: string, params?: unknown[]) {
      return client.query(sql, params ?? []);
    },
  };
}

describe("PostgresStore (fake pool)", () => {
  it("claims, completes, and replays", async () => {
    const pool = createFakePool() as unknown as import("pg").Pool;
    const store = new PostgresStore({ pool, ensureSchema: true });
    const idem = new Idempotency({ store });

    let calls = 0;
    const first = await idem.run(
      "pg-1",
      { method: "POST", path: "/o", body: "{}" },
      async () => {
        calls += 1;
        return { statusCode: 201, body: '{"ok":true}' };
      },
    );
    const second = await idem.run(
      "pg-1",
      { method: "POST", path: "/o", body: "{}" },
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
});

const databaseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(databaseUrl))("PostgresStore (live DATABASE_URL)", () => {
  it("works against a real database", async () => {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: databaseUrl });
    const store = new PostgresStore({
      pool,
      table: `idempotency_keys_test_${Date.now()}`,
    });
    await store.ready();
    const idem = new Idempotency({ store });

    const result = await idem.run(
      "live-1",
      { method: "POST", path: "/x", body: "a" },
      async () => ({ statusCode: 200, body: "live" }),
    );
    expect(result.response.body).toBe("live");
    await pool.end();
  });
});
