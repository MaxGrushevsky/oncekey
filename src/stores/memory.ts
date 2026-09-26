import type {
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResponse,
} from "../types.js";

/**
 * In-process store. Fine for tests and a single Node process.
 * Keys are lost on restart. Do not use behind multiple instances.
 *
 * Per-key operations are serialized so overlapping async claims cannot
 * double-acquire inside one process.
 */
export class MemoryStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  private async withKeyLock<T>(
    storageKey: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(storageKey) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => held);
    this.locks.set(storageKey, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(storageKey) === tail) {
        this.locks.delete(storageKey);
      }
    }
  }

  async claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult> {
    return this.withKeyLock(input.storageKey, () => {
      const existing = this.records.get(input.storageKey);

      if (!existing || existing.expiresAt <= input.now) {
        this.records.set(
          input.storageKey,
          newProcessing(
            input.storageKey,
            input.fingerprint,
            input.now,
            input.ttlMs,
          ),
        );
        return { kind: "acquired" as const };
      }

      if (existing.fingerprint !== input.fingerprint) {
        return { kind: "mismatch" as const, record: clone(existing) };
      }

      if (existing.status === "completed" && existing.response) {
        return { kind: "replay" as const, record: clone(existing) };
      }

      const leaseDead = existing.lockedAt + input.leaseMs <= input.now;
      if (existing.status === "processing" && leaseDead) {
        this.records.set(
          input.storageKey,
          newProcessing(
            input.storageKey,
            input.fingerprint,
            input.now,
            input.ttlMs,
          ),
        );
        return { kind: "acquired" as const };
      }

      return { kind: "in_progress" as const, record: clone(existing) };
    });
  }

  async complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void> {
    await this.withKeyLock(input.storageKey, () => {
      const existing = this.records.get(input.storageKey);
      if (!existing || existing.fingerprint !== input.fingerprint) return;
      if (existing.status === "completed") return;

      this.records.set(input.storageKey, {
        ...existing,
        status: "completed",
        response: {
          statusCode: input.response.statusCode,
          headers: { ...input.response.headers },
          body: input.response.body,
        },
        updatedAt: input.now,
        expiresAt: input.now + input.ttlMs,
        lockedAt: input.now,
      });
    });
  }

  async abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void> {
    await this.withKeyLock(input.storageKey, () => {
      const existing = this.records.get(input.storageKey);
      if (!existing) return;
      if (existing.fingerprint !== input.fingerprint) return;
      if (existing.status === "completed") return;
      this.records.delete(input.storageKey);
    });
  }

  async get(storageKey: string): Promise<IdempotencyRecord | null> {
    const record = this.records.get(storageKey);
    return record ? clone(record) : null;
  }

  async purgeExpired(now: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function newProcessing(
  storageKey: string,
  fingerprint: string,
  now: number,
  ttlMs: number,
): IdempotencyRecord {
  return {
    storageKey,
    fingerprint,
    status: "processing",
    response: null,
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMs,
  };
}

function clone(record: IdempotencyRecord): IdempotencyRecord {
  return {
    ...record,
    response: record.response
      ? {
          statusCode: record.response.statusCode,
          headers: { ...record.response.headers },
          body: record.response.body,
        }
      : null,
  };
}
