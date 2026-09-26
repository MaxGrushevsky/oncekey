import type { Context, Handler, MiddlewareHandler } from "hono";
import {
  buildFingerprintInput,
  errorPayload,
  isIdempotencyHttpError,
  resolveHeaderName,
  resolveReplayHeader,
  type AdapterBaseOptions,
} from "./shared.js";
import { InProgressError } from "../errors.js";
import type { HandlerResult, StoredResponse } from "../types.js";

export type HonoIdempotencyOptions = AdapterBaseOptions & {
  scope?: (c: Context) => string | Promise<string>;
  fingerprintExtra?: (c: Context) => string | Promise<string>;
};

function storedToResponse(
  stored: StoredResponse,
  replayed: boolean,
  replayHeader: string,
): Response {
  const headers = new Headers(stored.headers);
  if (replayed) headers.set(replayHeader, "true");
  if (!headers.has("content-type") && stored.body.length > 0) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(stored.body, {
    status: stored.statusCode,
    headers,
  });
}

/**
 * Hono middleware. Fingerprints a clone of the body so downstream handlers
 * can still call `c.req.json()` / `c.req.text()`.
 *
 * ```ts
 * app.post(
 *   "/orders",
 *   honoIdempotency({ idempotency, scope: (c) => c.get("tenantId") }),
 *   async (c) => c.json({ id: "ord_1" }, 201),
 * );
 * ```
 */
export function honoIdempotency(
  options: HonoIdempotencyOptions,
): MiddlewareHandler {
  const headerName = resolveHeaderName(options);
  const replayHeader = resolveReplayHeader(options);
  const required = options.required ?? true;

  return async function oncekeyHono(c, next) {
    const key = c.req.header(headerName)?.trim() ?? "";

    if (!key) {
      if (!required) {
        await next();
        return;
      }
      return c.json(
        errorPayload({
          code: "missing_key",
          message: "Idempotency-Key header is required",
        }),
        400,
      );
    }

    const body = await c.req.raw.clone().text();
    const url = new URL(c.req.url);
    const scope = options.scope ? await options.scope(c) : "";
    const extra = options.fingerprintExtra
      ? await options.fingerprintExtra(c)
      : "";

    try {
      const result = await options.idempotency.run(
        key,
        buildFingerprintInput({
          method: c.req.method,
          path: `${url.pathname}${url.search}`,
          body,
          ...(extra ? { extra } : {}),
        }),
        async () => {
          await next();
          const res = c.res;
          const headers: Record<string, string> = {};
          res.headers.forEach((value, name) => {
            headers[name] = value;
          });
          const text = await res.clone().text();
          return {
            statusCode: res.status,
            headers,
            body: text,
          } satisfies HandlerResult;
        },
        scope,
      );

      if (result.replayed) {
        c.res = storedToResponse(result.response, true, replayHeader);
      }
    } catch (err) {
      if (isIdempotencyHttpError(err)) {
        if (err instanceof InProgressError) {
          c.header("Retry-After", String(err.retryAfterSeconds));
        }
        return c.json(errorPayload(err), err.statusCode as 400 | 409 | 422);
      }
      throw err;
    }
  };
}

/** Wrap a single handler (same semantics as middleware + one route). */
export function honoProtect(
  options: HonoIdempotencyOptions,
  handler: Handler,
): Handler {
  const mw = honoIdempotency(options);
  return async (c, next) => {
    await mw(c, async () => handler(c, next));
  };
}
