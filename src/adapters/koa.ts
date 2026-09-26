import type { Context, Middleware, Next } from "koa";
import {
  bodyToFingerprintString,
  buildFingerprintInput,
  errorPayload,
  isIdempotencyHttpError,
  resolveHeaderName,
  resolveReplayHeader,
  type AdapterBaseOptions,
} from "./shared.js";
import { InProgressError } from "../errors.js";
import type { HandlerResult } from "../types.js";

export type KoaIdempotencyOptions = AdapterBaseOptions & {
  scope?: (ctx: Context) => string | Promise<string>;
  fingerprintExtra?: (ctx: Context) => string | Promise<string>;
  getBody?: (ctx: Context) => string | Promise<string>;
};

/**
 * Koa middleware. Place after a body parser (e.g. koa-bodyparser).
 *
 * ```ts
 * app.use(koaIdempotency({ idempotency }));
 * ```
 *
 * Prefer mounting on specific routes rather than globally if only some
 * POSTs need idempotency.
 */
export function koaIdempotency(
  options: KoaIdempotencyOptions,
): Middleware {
  const headerName = resolveHeaderName(options);
  const replayHeader = resolveReplayHeader(options);
  const required = options.required ?? true;

  return async function oncekeyKoa(ctx: Context, next: Next) {
    try {
      const header = ctx.get(headerName) || ctx.get(headerName.toLowerCase());
      const key = header.trim();

      if (!key) {
        if (!required) {
          await next();
          return;
        }
        ctx.status = 400;
        ctx.body = errorPayload({
          code: "missing_key",
          message: "Idempotency-Key header is required",
        });
        return;
      }

      const body = options.getBody
        ? await options.getBody(ctx)
        : bodyToFingerprintString(
            (ctx.request as { body?: unknown }).body,
          );
      const scope = options.scope ? await options.scope(ctx) : "";
      const extra = options.fingerprintExtra
        ? await options.fingerprintExtra(ctx)
        : "";
      const path = ctx.originalUrl || ctx.url || "/";

      const result = await options.idempotency.run(
        key,
        buildFingerprintInput({
          method: ctx.method,
          path,
          body,
          ...(extra ? { extra } : {}),
        }),
        async () => {
          await next();
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(ctx.response.headers)) {
            if (value === undefined) continue;
            headers[name.toLowerCase()] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          }
          const responseBody =
            typeof ctx.body === "string"
              ? ctx.body
              : ctx.body === undefined || ctx.body === null
                ? ""
                : JSON.stringify(ctx.body);
          return {
            statusCode: ctx.status || 200,
            headers,
            body: responseBody,
          } satisfies HandlerResult;
        },
        scope,
      );

      if (result.replayed) {
        ctx.status = result.response.statusCode;
        for (const [name, value] of Object.entries(result.response.headers)) {
          ctx.set(name, value);
        }
        ctx.set(replayHeader, "true");
        const ct = result.response.headers["content-type"] ?? "";
        if (ct.includes("application/json")) {
          try {
            ctx.body = JSON.parse(result.response.body);
          } catch {
            ctx.body = result.response.body;
          }
        } else {
          ctx.body = result.response.body;
        }
      }
    } catch (err) {
      if (isIdempotencyHttpError(err)) {
        if (err instanceof InProgressError) {
          ctx.set("Retry-After", String(err.retryAfterSeconds));
        }
        ctx.status = err.statusCode;
        ctx.body = errorPayload(err);
        return;
      }
      throw err;
    }
  };
}
