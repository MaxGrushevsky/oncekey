import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  applyStoredHeaders,
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

export type ExpressIdempotencyOptions = AdapterBaseOptions & {
  scope?: (req: Request) => string | Promise<string>;
  fingerprintExtra?: (req: Request) => string | Promise<string>;
  /**
   * Body used for the fingerprint.
   * Default: `req.rawBody` when present, otherwise `JSON.stringify(req.body)`.
   */
  getBody?: (req: Request) => string | Promise<string>;
};

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: string | Buffer;
    idempotentReplay?: boolean;
  }
}

type ExpressRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>;

function readBody(
  req: Request,
  getBody?: ExpressIdempotencyOptions["getBody"],
): Promise<string> {
  if (getBody) return Promise.resolve(getBody(req));
  if (req.rawBody !== undefined) {
    return Promise.resolve(bodyToFingerprintString(req.rawBody));
  }
  return Promise.resolve(bodyToFingerprintString(req.body));
}

function pathWithQuery(req: Request): string {
  if (req.originalUrl) {
    try {
      const u = new URL(req.originalUrl, "http://localhost");
      return `${u.pathname}${u.search}`;
    } catch {
      return req.originalUrl;
    }
  }
  return req.url || "/";
}

/**
 * Wrap one Express route handler with idempotency.
 *
 * ```ts
 * app.post(
 *   "/orders",
 *   express.json(),
 *   expressIdempotency({ idempotency, scope: (req) => req.user.tenantId })(
 *     async (req, res) => {
 *       const order = await createOrder(req.body);
 *       res.status(201).json(order);
 *     },
 *   ),
 * );
 * ```
 */
export function expressIdempotency(
  options: ExpressIdempotencyOptions,
): (handler: ExpressRouteHandler) => RequestHandler {
  const headerName = resolveHeaderName(options);
  const replayHeader = resolveReplayHeader(options);
  const required = options.required ?? true;

  return (handler: ExpressRouteHandler): RequestHandler => {
    return async function oncekeyExpress(req, res, next) {
      try {
        const header =
          req.header(headerName) ?? req.header(headerName.toLowerCase());
        const key = header?.trim() ?? "";

        if (!key) {
          if (!required) {
            await Promise.resolve(handler(req, res, next));
            return;
          }
          res.status(400).json(
            errorPayload({
              code: "missing_key",
              message: "Idempotency-Key header is required",
            }),
          );
          return;
        }

        const body = await readBody(req, options.getBody);
        const scope = options.scope ? await options.scope(req) : "";
        const extra = options.fingerprintExtra
          ? await options.fingerprintExtra(req)
          : "";

        const result = await options.idempotency.run(
          key,
          buildFingerprintInput({
            method: req.method,
            path: pathWithQuery(req),
            body,
            ...(extra ? { extra } : {}),
          }),
          async () => runAndCapture(handler, req, res, next),
          scope,
        );

        if (result.replayed) {
          req.idempotentReplay = true;
          if (!res.headersSent) {
            applyStoredHeaders(
              (name, value) => {
                res.setHeader(name, value);
              },
              result.response,
              true,
              replayHeader,
            );
            res.status(result.response.statusCode);
            // Body was stored as text; send as-is.
            if (
              result.response.headers["content-type"]?.includes(
                "application/json",
              )
            ) {
              try {
                res.send(JSON.parse(result.response.body));
              } catch {
                res.send(result.response.body);
              }
            } else {
              res.send(result.response.body);
            }
          }
          return;
        }

        // First execution already wrote via the wrapped res.
      } catch (err) {
        if (isIdempotencyHttpError(err)) {
          if (!res.headersSent) {
            if (err instanceof InProgressError) {
              res.setHeader("Retry-After", String(err.retryAfterSeconds));
            }
            res.status(err.statusCode).json(errorPayload(err));
          }
          return;
        }
        next(err);
      }
    };
  };
}

function runAndCapture(
  handler: ExpressRouteHandler,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<HandlerResult> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let settled = false;

    const originalStatus = res.status.bind(res);
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSetHeader = res.setHeader.bind(res);

    const settle = (body: string) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode, headers, body });
    };

    res.status = ((code: number) => {
      statusCode = code;
      return originalStatus(code);
    }) as Response["status"];

    res.setHeader = ((
      name: string,
      value: string | number | readonly string[],
    ) => {
      headers[String(name).toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
      return originalSetHeader(name, value as string);
    }) as Response["setHeader"];

    res.json = ((payload: unknown) => {
      headers["content-type"] =
        headers["content-type"] ?? "application/json; charset=utf-8";
      const body =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      settle(body);
      return originalJson(payload);
    }) as Response["json"];

    res.send = ((payload?: unknown) => {
      let body = "";
      if (typeof payload === "string") body = payload;
      else if (Buffer.isBuffer(payload)) body = payload.toString("utf8");
      else if (payload !== undefined && payload !== null) {
        body = JSON.stringify(payload);
        headers["content-type"] =
          headers["content-type"] ?? "application/json; charset=utf-8";
      }
      settle(body);
      return originalSend(payload as string);
    }) as Response["send"];

    res.end = ((...args: unknown[]) => {
      const chunk = args[0];
      if (typeof chunk === "string") settle(chunk);
      else if (Buffer.isBuffer(chunk)) settle(chunk.toString("utf8"));
      else settle("");
      return originalEnd.apply(res, args as never);
    }) as Response["end"];

    Promise.resolve()
      .then(() => handler(req, res, next))
      .then(() => {
        if (!settled && res.headersSent) {
          settle("");
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}
