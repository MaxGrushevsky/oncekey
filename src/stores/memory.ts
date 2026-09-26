import type {
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResponse,
} from "../types.js";

/**
 * In-process store. Fine for tests and a single Node process.
 * Keys are lost on restart. Do not use behind multiple instances.
 */
export class MemoryStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult> {
    const existing = this.records.get(input.storageKey);

    if (!existing || existing.expiresAt <= input.now) {
      const record = newProcessing(
        input.storageKey,
        input.fingerprint,
        input.now,
        input.ttlMs,
      );
      this.records.set(input.storageKey, record);
      return { kind: "acquired" };
    }

    if (existing.fingerprint !== input.fingerprint) {
      return { kind: "mismatch", record: clone(existing) };
    }

    if (existing.status === "completed" && existing.response) {
      return { kind: "replay", record: clone(existing) };
    }

    const leaseDead = existing.lockedAt + input.leaseMs <= input.now;
    if (existing.status === "processing" && leaseDead) {
      const record = newProcessing(
        input.storageKey,
        input.fingerprint,
        input.now,
        input.ttlMs,
      );
      this.records.set(input.storageKey, record);
      return { kind: "acquired" };
    }

    return { kind: "in_progress", record: clone(existing) };
  }

  async complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void> {
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
  }

  async abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void> {
    const existing = this.records.get(input.storageKey);
    if (!existing) return;
    if (existing.fingerprint !== input.fingerprint) return;
    if (existing.status === "completed") return;
    this.records.delete(input.storageKey);
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
