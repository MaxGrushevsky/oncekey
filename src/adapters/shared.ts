import type { Idempotency } from "../idempotency.js";
import type { FingerprintInput, StoredResponse } from "../types.js";
import {
  InProgressError,
  InvalidKeyError,
  KeyMismatchError,
  MissingKeyError,
} from "../errors.js";

export type AdapterBaseOptions = {
  idempotency: Idempotency;
  headerName?: string;
  required?: boolean;
  replayHeader?: string;
};

export function resolveHeaderName(options: AdapterBaseOptions): string {
  return options.headerName ?? "Idempotency-Key";
}

export function resolveReplayHeader(options: AdapterBaseOptions): string {
  return options.replayHeader ?? "Idempotent-Replay";
}

export function isIdempotencyHttpError(
  err: unknown,
): err is MissingKeyError | InvalidKeyError | KeyMismatchError | InProgressError {
  return (
    err instanceof MissingKeyError ||
    err instanceof InvalidKeyError ||
    err instanceof KeyMismatchError ||
    err instanceof InProgressError
  );
}

export function errorPayload(err: {
  code: string;
  message: string;
}): { error: string; message: string } {
  return { error: err.code, message: err.message };
}

export function buildFingerprintInput(input: {
  method: string;
  path: string;
  body: string;
  extra?: string;
}): FingerprintInput {
  return {
    method: input.method,
    path: input.path,
    body: input.body,
    ...(input.extra ? { extra: input.extra } : {}),
  };
}

/** Serialize Express/Hono parsed bodies into a stable-enough fingerprint string. */
export function bodyToFingerprintString(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return JSON.stringify(body);
}

export function applyStoredHeaders(
  setHeader: (name: string, value: string) => void,
  stored: StoredResponse,
  replayed: boolean,
  replayHeader: string,
): void {
  for (const [name, value] of Object.entries(stored.headers)) {
    setHeader(name, value);
  }
  if (replayed) {
    setHeader(replayHeader, "true");
  }
}
