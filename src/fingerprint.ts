import { createHash } from "node:crypto";
import type { FingerprintInput } from "./types.js";

function bodyToBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  return body;
}

/**
 * Recursively sort object keys so semantically equal JSON fingerprints match
 * even when clients reshuffle key order.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalizeJson(obj[key]);
  }
  return out;
}

/**
 * If `body` is JSON text, return a canonical JSON string; otherwise return as-is.
 */
export function maybeCanonicalBody(
  body: string | Uint8Array,
  enabled: boolean,
): string | Uint8Array {
  if (!enabled) return body;
  const text =
    typeof body === "string" ? body : new TextDecoder().decode(body);
  const trimmed = text.trim();
  if (!trimmed) return body;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return JSON.stringify(canonicalizeJson(parsed));
  } catch {
    return body;
  }
}

/**
 * Stable fingerprint of the request that owns an idempotency key.
 */
export function fingerprint(
  input: FingerprintInput,
  options?: { canonicalJson?: boolean },
): string {
  const method = input.method.trim().toUpperCase();
  const path = normalizePath(input.path);
  const body = maybeCanonicalBody(input.body, options?.canonicalJson === true);
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(path);
  hash.update("\n");
  hash.update(bodyToBytes(body));
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
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    const q = trimmed.indexOf("?");
    if (q === -1) return trimmed.slice(0, -1);
    // trailing slash before query is unusual; leave as-is
    return trimmed;
  }
  return trimmed;
}

export function buildStorageKey(scope: string, key: string): string {
  const s = scope.trim();
  return s === "" ? key : `${s}:${key}`;
}

const DEFAULT_MAX_KEY_LENGTH = 255;

export type KeyValidationError = "empty" | "too_long" | "invalid_chars";

export function validateKey(
  key: string,
  maxLength = DEFAULT_MAX_KEY_LENGTH,
): KeyValidationError | null {
  if (key.length === 0) return "empty";
  if (key.length > maxLength) return "too_long";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "invalid_chars";
  return null;
}

export function assertValidKey(
  key: string,
  maxLength = DEFAULT_MAX_KEY_LENGTH,
): void {
  const err = validateKey(key, maxLength);
  if (err) throw new Error(err);
}
