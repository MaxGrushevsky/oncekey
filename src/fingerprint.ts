import { createHash } from "node:crypto";
import type { FingerprintInput } from "./types.js";

function bodyToBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  return body;
}

/**
 * Stable fingerprint of the request that owns an idempotency key.
 *
 * Same method + path + body (+ optional extra) → same hash.
 * JSON key order in the body is not normalized; pass a canonical
 * string if your clients reshuffle object keys.
 */
export function fingerprint(input: FingerprintInput): string {
  const method = input.method.trim().toUpperCase();
  const path = normalizePath(input.path);
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(path);
  hash.update("\n");
  hash.update(bodyToBytes(input.body));
  if (input.extra !== undefined && input.extra !== "") {
    hash.update("\n");
    hash.update(input.extra);
  }
  return hash.digest("hex");
}

function normalizePath(path: string): string {
  if (!path) return "/";
  const trimmed = path.trim();
  if (trimmed === "") return "/";
  // Drop trailing slash except for root, keep query string as-is.
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function buildStorageKey(scope: string, key: string): string {
  const s = scope.trim();
  return s === "" ? key : `${s}:${key}`;
}

const DEFAULT_MAX_KEY_LENGTH = 255;

export function assertValidKey(
  key: string,
  maxLength = DEFAULT_MAX_KEY_LENGTH,
): void {
  if (key.length === 0) {
    throw new Error("empty");
  }
  if (key.length > maxLength) {
    throw new Error("too_long");
  }
  // Reject control characters; allow typical UUID / ulid / base64url keys.
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("invalid_chars");
  }
}
