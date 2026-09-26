import {
  IdempotencyError,
  InProgressError,
  InvalidKeyError,
  KeyMismatchError,
  MissingKeyError,
} from "./errors.js";
import { Idempotency } from "./idempotency.js";
import type { FingerprintInput, HandlerResult, StoredResponse } from "./types.js";

export type HttpRequestParts = {
  method: string;
  /** Path + optional query, e.g. /orders or /orders?foo=1 */
  path: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** Raw body text. Read the stream once before calling. */
  body: string;
};

export type ProtectOptions = {
  idempotency: Idempotency;
  /**
   * Header that carries the key. Default: Idempotency-Key
   */
  headerName?: string;
  /**
   * When true, missing key → 400.
   * When false, missing key runs the handler without idempotency.
   */
  required?: boolean;
  /**
   * Scope keys per tenant / user. Return empty string for a global namespace.
   */
  scope?: (request: HttpRequestParts) => string | Promise<string>;
  /**
   * Extra fingerprint material (e.g. authenticated user id).
   */
  fingerprintExtra?: (
    request: HttpRequestParts,
  ) => string | Promise<string>;
  /**
   * Name of the replay marker header. Default: Idempotent-Replay
   */
  replayHeader?: string;
};

function headerValue(
  headers: HttpRequestParts["headers"],
  name: string,
): string | null {
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name) ?? headers.get(lower);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    }
  }
  return null;
}

function errorResponse(err: IdempotencyError, replayHeader: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  if (err instanceof InProgressError) {
    headers.set("retry-after", String(err.retryAfterSeconds));
  }
  // silence unused in non-in-progress paths
  void replayHeader;
  return new Response(
    JSON.stringify({
      error: err.code,
      message: err.message,
    }),
    { status: err.statusCode, headers },
  );
}

function storedToResponse(
  stored: StoredResponse,
  replayed: boolean,
  replayHeader: string,
): Response {
  const headers = new Headers(stored.headers);
  if (replayed) {
    headers.set(replayHeader, "true");
  }
  if (!headers.has("content-type") && stored.body.length > 0) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(stored.body, {
    status: stored.statusCode,
    headers,
  });
}

async function responseToHandlerResult(
  response: Response,
): Promise<HandlerResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
  };
}

/**
 * Wrap a `fetch`-style handler (Next.js App Router, Hono `c.req.raw`, etc.).
 *
 * Reads `Idempotency-Key`, runs the handler at most once, returns a Response.
 */
export function protect(
  options: ProtectOptions,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  const headerName = options.headerName ?? "Idempotency-Key";
  const required = options.required ?? true;
  const replayHeader = options.replayHeader ?? "Idempotent-Replay";

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = await request.clone().text();
    const parts: HttpRequestParts = {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
    };

    const key = headerValue(parts.headers, headerName);

    if ((key === null || key.trim() === "") && !required) {
      return handler(request);
    }

    const scope = options.scope ? await options.scope(parts) : "";
    const extra = options.fingerprintExtra
      ? await options.fingerprintExtra(parts)
      : "";

    const fingerprintInput: FingerprintInput = {
      method: parts.method,
      path: parts.path,
      body,
      ...(extra ? { extra } : {}),
    };

    try {
      const result = await options.idempotency.run(
        key,
        fingerprintInput,
        async () => responseToHandlerResult(await handler(request)),
        scope,
      );
      return storedToResponse(result.response, result.replayed, replayHeader);
    } catch (err) {
      if (
        err instanceof MissingKeyError ||
        err instanceof InvalidKeyError ||
        err instanceof KeyMismatchError ||
        err instanceof InProgressError
      ) {
        return errorResponse(err, replayHeader);
      }
      throw err;
    }
  };
}
