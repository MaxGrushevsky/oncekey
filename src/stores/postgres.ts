import type { Pool, PoolClient } from "pg";
import type {
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResponse,
} from "../types.js";

export type PostgresStoreOptions = {
  pool: Pool;
  /** Default: idempotency_keys */
  table?: string;
  /** Create the table on first use. Default: true */
  ensureSchema?: boolean;
};

type Row = {
  storage_key: string;
  fingerprint: string;
  status: string;
  response_json: string | null;
  locked_at: string | number;
  created_at: string | number;
  updated_at: string | number;
  expires_at: string | number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

/**
 * Postgres-backed store for multi-instance deployments.
 *
 * ```ts
 * import pg from "pg";
 * import { Idempotency } from "oncekey";
 * import { PostgresStore } from "oncekey/postgres";
 *
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const store = new PostgresStore({ pool });
 * await store.ready();
 * const idem = new Idempotency({ store });
 * ```
 *
 * `pg` is an optional peer dependency — install it in your app.
 */
export class PostgresStore implements IdempotencyStore {
  private readonly pool: Pool;
  private readonly table: string;
  private readonly ensureSchema: boolean;
  private readyPromise: Promise<void> | null = null;

  constructor(options: PostgresStoreOptions) {
    this.pool = options.pool;
    this.table = options.table ?? "idempotency_keys";
    this.ensureSchema = options.ensureSchema ?? true;
  }

  async ready(): Promise<void> {
    if (!this.ensureSchema) return;
    if (!this.readyPromise) {
      this.readyPromise = this.migrate();
    }
    await this.readyPromise;
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        storage_key   TEXT PRIMARY KEY,
        fingerprint   TEXT NOT NULL,
        status        TEXT NOT NULL,
        response_json JSONB,
        locked_at     BIGINT NOT NULL,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL,
        expires_at    BIGINT NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.table}_expires_at_idx
        ON ${this.table} (expires_at)
    `);
  }

  async claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${this.table} WHERE storage_key = $1 AND expires_at <= $2`,
        [input.storageKey, input.now],
      );

      const existing = await this.read(client, input.storageKey);

      if (!existing) {
        await client.query(
          `
          INSERT INTO ${this.table} (
            storage_key, fingerprint, status, response_json,
            locked_at, created_at, updated_at, expires_at
          ) VALUES ($1, $2, 'processing', NULL, $3, $3, $3, $4)
          `,
          [
            input.storageKey,
            input.fingerprint,
            input.now,
            input.now + input.ttlMs,
          ],
        );
        await client.query("COMMIT");
        return { kind: "acquired" };
      }

      if (existing.fingerprint !== input.fingerprint) {
        await client.query("COMMIT");
        return { kind: "mismatch", record: existing };
      }

      if (existing.status === "completed" && existing.response) {
        await client.query("COMMIT");
        return { kind: "replay", record: existing };
      }

      const leaseDead = existing.lockedAt + input.leaseMs <= input.now;
      if (existing.status === "processing" && leaseDead) {
        await client.query(
          `
          UPDATE ${this.table}
          SET fingerprint = $2,
              status = 'processing',
              response_json = NULL,
              locked_at = $3,
              updated_at = $3,
              expires_at = $4
          WHERE storage_key = $1
          `,
          [
            input.storageKey,
            input.fingerprint,
            input.now,
            input.now + input.ttlMs,
          ],
        );
        await client.query("COMMIT");
        return { kind: "acquired" };
      }

      await client.query("COMMIT");
      return { kind: "in_progress", record: existing };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void> {
    await this.ready();
    await this.pool.query(
      `
      UPDATE ${this.table}
      SET status = 'completed',
          response_json = $3::jsonb,
          updated_at = $4,
          locked_at = $4,
          expires_at = $5
      WHERE storage_key = $1
        AND fingerprint = $2
        AND status = 'processing'
      `,
      [
        input.storageKey,
        input.fingerprint,
        JSON.stringify(input.response),
        input.now,
        input.now + input.ttlMs,
      ],
    );
  }

  async abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void> {
    await this.ready();
    await this.pool.query(
      `
      DELETE FROM ${this.table}
      WHERE storage_key = $1
        AND fingerprint = $2
        AND status = 'processing'
      `,
      [input.storageKey, input.fingerprint],
    );
  }

  async get(storageKey: string): Promise<IdempotencyRecord | null> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      return await this.read(client, storageKey);
    } finally {
      client.release();
    }
  }

  async purgeExpired(now: number): Promise<number> {
    await this.ready();
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  private async read(
    client: PoolClient,
    storageKey: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await client.query(
      `SELECT * FROM ${this.table} WHERE storage_key = $1 FOR UPDATE`,
      [storageKey],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }
}

function rowToRecord(row: Row): IdempotencyRecord {
  let response: StoredResponse | null = null;
  if (row.response_json) {
    response =
      typeof row.response_json === "string"
        ? (JSON.parse(row.response_json) as StoredResponse)
        : (row.response_json as unknown as StoredResponse);
  }
  return {
    storageKey: row.storage_key,
    fingerprint: row.fingerprint,
    status: row.status as IdempotencyRecord["status"],
    response,
    lockedAt: num(row.locked_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    expiresAt: num(row.expires_at),
  };
}
