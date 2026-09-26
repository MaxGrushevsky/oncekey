import { DatabaseSync } from "node:sqlite";
import type {
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResponse,
} from "../types.js";

export type SqliteStoreOptions = {
  /** File path, or ":memory:" for an ephemeral database. */
  path: string;
  /** Optional table name. Default: idempotency_keys */
  table?: string;
};

type Row = {
  storage_key: string;
  fingerprint: string;
  status: string;
  response_json: string | null;
  locked_at: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

/**
 * SQLite-backed store using Node's built-in `node:sqlite` (Node 22+).
 *
 * No separate database server. Point `path` at a file on disk, or use
 * `:memory:` in tests. Safe for multiple processes on the same file
 * when SQLite locking cooperates; for many app instances prefer Postgres later.
 */
export class SqliteStore implements IdempotencyStore {
  private readonly db: DatabaseSync;
  private readonly table: string;

  constructor(options: SqliteStoreOptions) {
    this.table = options.table ?? "idempotency_keys";
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        storage_key   TEXT PRIMARY KEY NOT NULL,
        fingerprint   TEXT NOT NULL,
        status        TEXT NOT NULL,
        response_json TEXT,
        locked_at     INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.table}_expires_at_idx
        ON ${this.table} (expires_at);
    `);
  }

  async claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult> {
    return this.withImmediateTransaction(() => {
      this.deleteIfExpired(input.storageKey, input.now);
      const existing = this.read(input.storageKey);

      if (!existing) {
        this.insertProcessing(
          input.storageKey,
          input.fingerprint,
          input.now,
          input.ttlMs,
        );
        return { kind: "acquired" as const };
      }

      if (existing.fingerprint !== input.fingerprint) {
        return { kind: "mismatch" as const, record: existing };
      }

      if (existing.status === "completed" && existing.response) {
        return { kind: "replay" as const, record: existing };
      }

      const leaseDead = existing.lockedAt + input.leaseMs <= input.now;
      if (existing.status === "processing" && leaseDead) {
        this.takeOver(
          input.storageKey,
          input.fingerprint,
          input.now,
          input.ttlMs,
        );
        return { kind: "acquired" as const };
      }

      return { kind: "in_progress" as const, record: existing };
    });
  }

  async complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void> {
    this.withImmediateTransaction(() => {
      const existing = this.read(input.storageKey);
      if (!existing || existing.fingerprint !== input.fingerprint) return;
      if (existing.status === "completed") return;

      const stmt = this.db.prepare(`
        UPDATE ${this.table}
        SET status = 'completed',
            response_json = ?,
            updated_at = ?,
            locked_at = ?,
            expires_at = ?
        WHERE storage_key = ?
          AND fingerprint = ?
          AND status = 'processing'
      `);
      stmt.run(
        JSON.stringify(input.response),
        input.now,
        input.now,
        input.now + input.ttlMs,
        input.storageKey,
        input.fingerprint,
      );
    });
  }

  async abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM ${this.table}
      WHERE storage_key = ?
        AND fingerprint = ?
        AND status = 'processing'
    `);
    stmt.run(input.storageKey, input.fingerprint);
  }

  async get(storageKey: string): Promise<IdempotencyRecord | null> {
    return this.read(storageKey);
  }

  async purgeExpired(now: number): Promise<number> {
    const stmt = this.db.prepare(
      `DELETE FROM ${this.table} WHERE expires_at <= ?`,
    );
    const result = stmt.run(now);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private deleteIfExpired(storageKey: string, now: number): void {
    this.db
      .prepare(
        `DELETE FROM ${this.table} WHERE storage_key = ? AND expires_at <= ?`,
      )
      .run(storageKey, now);
  }

  private insertProcessing(
    storageKey: string,
    fingerprint: string,
    now: number,
    ttlMs: number,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO ${this.table} (
        storage_key, fingerprint, status, response_json,
        locked_at, created_at, updated_at, expires_at
      ) VALUES (?, ?, 'processing', NULL, ?, ?, ?, ?)
    `,
      )
      .run(storageKey, fingerprint, now, now, now, now + ttlMs);
  }

  private takeOver(
    storageKey: string,
    fingerprint: string,
    now: number,
    ttlMs: number,
  ): void {
    this.db
      .prepare(
        `
      UPDATE ${this.table}
      SET fingerprint = ?,
          status = 'processing',
          response_json = NULL,
          locked_at = ?,
          updated_at = ?,
          expires_at = ?
      WHERE storage_key = ?
    `,
      )
      .run(fingerprint, now, now, now + ttlMs, storageKey);
  }

  private read(storageKey: string): IdempotencyRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE storage_key = ?`)
      .get(storageKey) as Row | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }

  /**
   * node:sqlite has no db.transaction() helper yet; BEGIN IMMEDIATE
   * serializes writers on this connection.
   */
  private withImmediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw err;
    }
  }
}

function rowToRecord(row: Row): IdempotencyRecord {
  let response: StoredResponse | null = null;
  if (row.response_json) {
    response = JSON.parse(row.response_json) as StoredResponse;
  }
  return {
    storageKey: row.storage_key,
    fingerprint: row.fingerprint,
    status: row.status as IdempotencyRecord["status"],
    response,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
