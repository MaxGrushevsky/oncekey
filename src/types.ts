export type StoredResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type RecordStatus = "processing" | "completed";

export type IdempotencyRecord = {
  /** Composite storage key: scope + raw idempotency key */
  storageKey: string;
  fingerprint: string;
  status: RecordStatus;
  response: StoredResponse | null;
  /** When the processing lease was taken / last refreshed */
  lockedAt: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type ClaimResult =
  | { kind: "acquired" }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "in_progress"; record: IdempotencyRecord }
  | { kind: "mismatch"; record: IdempotencyRecord };

/**
 * Persistence for idempotency keys.
 *
 * Implementations must make `claim` atomic under concurrent callers.
 * If two processes claim the same key at once, only one may get `acquired`.
 */
export interface IdempotencyStore {
  /**
   * Try to own `storageKey` for `fingerprint`.
   *
   * - No row, or expired row → insert as `processing`, return `acquired`
   * - Completed, same fingerprint → `replay`
   * - Completed / processing, different fingerprint → `mismatch`
   * - Processing, lease still valid → `in_progress`
   * - Processing, lease expired (zombie) → take over, return `acquired`
   */
  claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult>;

  complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void>;

  /**
   * Drop a processing row after a handler failure so the client can retry
   * with the same key. Completed rows must not be deleted here.
   */
  abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void>;

  get(storageKey: string): Promise<IdempotencyRecord | null>;

  /** Optional cleanup hook for stores that do not expire rows lazily. */
  purgeExpired?(now: number): Promise<number>;
}

export type FingerprintInput = {
  method: string;
  path: string;
  /** Raw body bytes or string. Empty string if there is no body. */
  body: string | Uint8Array;
  /** Extra material (tenant id, user id) folded into the hash. */
  extra?: string;
};

export type HandlerResult = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string | Uint8Array | object | null;
};

export type RunResult = {
  replayed: boolean;
  response: StoredResponse;
};

export type IdempotencyOptions = {
  store: IdempotencyStore;
  /** How long a completed response can be replayed. Default: 24h. */
  ttlMs?: number;
  /** How long a crashed handler may hold the key before another worker may reclaim it. Default: 60s. */
  leaseMs?: number;
  /** Clock, overridable in tests. */
  now?: () => number;
  /**
   * Which response status codes are stored for replay.
   * Default: all except 5xx and 409 (in-progress conflicts).
   */
  shouldStore?: (statusCode: number) => boolean;
  /**
   * Headers copied into the stored response.
   * Authorization / cookie style headers are never stored.
   */
  headerFilter?: (name: string, value: string) => boolean;
};
