import {
  InProgressError,
  InvalidKeyError,
  KeyMismatchError,
  MissingKeyError,
} from "./errors.js";
import {
  assertValidKey,
  buildStorageKey,
  fingerprint as hashFingerprint,
} from "./fingerprint.js";
import type {
  FingerprintInput,
  HandlerResult,
  IdempotencyOptions,
  RunResult,
  StoredResponse,
} from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;

const BLOCKED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

function defaultShouldStore(statusCode: number): boolean {
  if (statusCode >= 500) return false;
  if (statusCode === 409) return false;
  return true;
}

function defaultHeaderFilter(name: string): boolean {
  return !BLOCKED_HEADERS.has(name.toLowerCase());
}

function encodeBody(body: HandlerResult["body"]): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("base64url");
  }
  return JSON.stringify(body);
}

function toStoredResponse(
  result: HandlerResult,
  headerFilter: (name: string, value: string) => boolean,
): StoredResponse {
  const headers: Record<string, string> = {};
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      if (headerFilter(name, value)) {
        headers[name.toLowerCase()] = value;
      }
    }
  }
  return {
    statusCode: result.statusCode,
    headers,
    body: encodeBody(result.body),
  };
}

export class Idempotency {
  private readonly store: IdempotencyOptions["store"];
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly shouldStore: (statusCode: number) => boolean;
  private readonly headerFilter: (name: string, value: string) => boolean;

  constructor(options: IdempotencyOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? Date.now;
    this.shouldStore = options.shouldStore ?? defaultShouldStore;
    this.headerFilter = options.headerFilter ?? defaultHeaderFilter;
  }

  /**
   * Run `handler` at most once for the given idempotency key.
   *
   * @param key - Value of the Idempotency-Key header
   * @param request - Material used for the fingerprint
   * @param handler - Side-effecting work (create charge, insert order, …)
   * @param scope - Tenant / user boundary so keys never collide across accounts
   */
  async run(
    key: string | null | undefined,
    request: FingerprintInput,
    handler: () => Promise<HandlerResult>,
    scope = "",
  ): Promise<RunResult> {
    if (key === null || key === undefined) {
      throw new MissingKeyError();
    }
    const trimmed = key.trim();
    try {
      assertValidKey(trimmed);
    } catch {
      throw new InvalidKeyError();
    }

    const fp = hashFingerprint(request);
    const storageKey = buildStorageKey(scope, trimmed);
    const now = this.now();

    const claim = await this.store.claim({
      storageKey,
      fingerprint: fp,
      now,
      ttlMs: this.ttlMs,
      leaseMs: this.leaseMs,
    });

    if (claim.kind === "replay") {
      if (!claim.record.response) {
        throw new Error("idempotency store returned replay without response");
      }
      return { replayed: true, response: claim.record.response };
    }

    if (claim.kind === "mismatch") {
      throw new KeyMismatchError();
    }

    if (claim.kind === "in_progress") {
      throw new InProgressError(
        Math.max(1, Math.ceil(this.leaseMs / 1000 / 4)),
      );
    }

    try {
      const result = await handler();
      const stored = toStoredResponse(result, this.headerFilter);

      if (this.shouldStore(stored.statusCode)) {
        await this.store.complete({
          storageKey,
          fingerprint: fp,
          response: stored,
          now: this.now(),
          ttlMs: this.ttlMs,
        });
      } else {
        await this.store.abandon({ storageKey, fingerprint: fp });
      }

      return { replayed: false, response: stored };
    } catch (err) {
      await this.store.abandon({ storageKey, fingerprint: fp });
      throw err;
    }
  }
}

export { fingerprint, buildStorageKey, assertValidKey } from "./fingerprint.js";
