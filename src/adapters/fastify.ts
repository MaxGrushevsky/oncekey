import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
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

export type FastifyIdempotencyOptions = AdapterBaseOptions & {
  scope?: (request: FastifyRequest) => string | Promise<string>;
  fingerprintExtra?: (request: FastifyRequest) => string | Promise<string>;
  getBody?: (request: FastifyRequest) => string | Promise<string>;
};

/**
 * Wrap a Fastify route handler.
 *
 * ```ts
 * fastify.post('/orders', fastifyIdempotency({ idempotency })(async (req, reply) => {
 *   return reply.code(201).send({ id: 'ord_1' });
 * }));
 * ```
 */
export function fastifyIdempotency(
  options: FastifyIdempotencyOptions,
): (handler: RouteHandlerMethod) => RouteHandlerMethod {
  const headerName = resolveHeaderName(options);
  const replayHeader = resolveReplayHeader(options);
  const required = options.required ?? true;

  return (handler: RouteHandlerMethod): RouteHandlerMethod => {
    return async function oncekeyFastify(request, reply) {
      try {
        const header = headerFromFastify(request, headerName);
        const key = header?.trim() ?? "";

        if (!key) {
          if (!required) {
            return handler.call(this, request, reply);
          }
          return reply.code(400).send(
            errorPayload({
              code: "missing_key",
              message: "Idempotency-Key header is required",
            }),
          );
        }

        const body = options.getBody
          ? await options.getBody(request)
          : bodyToFingerprintString(request.body);
        const scope = options.scope ? await options.scope(request) : "";
        const extra = options.fingerprintExtra
          ? await options.fingerprintExtra(request)
          : "";
        const url = request.url || "/";

        const result = await options.idempotency.run(
          key,
          buildFingerprintInput({
            method: request.method,
            path: url,
            body,
            ...(extra ? { extra } : {}),
          }),
          async () => captureFastify(handler, this, request, reply),
          scope,
        );

        if (result.replayed) {
          if (!reply.sent) {
            applyStoredHeaders(
              (name, value) => {
                void reply.header(name, value);
              },
              result.response,
              true,
              replayHeader,
            );
            const ct = result.response.headers["content-type"] ?? "";
            if (ct.includes("application/json")) {
              try {
                return reply
                  .code(result.response.statusCode)
                  .send(JSON.parse(result.response.body));
              } catch {
                return reply
                  .code(result.response.statusCode)
                  .send(result.response.body);
              }
            }
            return reply
              .code(result.response.statusCode)
              .send(result.response.body);
          }
        }
      } catch (err) {
        if (isIdempotencyHttpError(err)) {
          if (!reply.sent) {
            if (err instanceof InProgressError) {
              void reply.header("Retry-After", String(err.retryAfterSeconds));
            }
            return reply.code(err.statusCode).send(errorPayload(err));
          }
          return;
        }
        throw err;
      }
    };
  };
}

function headerFromFastify(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const value = request.headers[lower] ?? request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function captureFastify(
  handler: RouteHandlerMethod,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thisArg: any,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<HandlerResult> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let settled = false;

    const originalCode = reply.code.bind(reply);
    const originalHeader = reply.header.bind(reply);
    const originalSend = reply.send.bind(reply);

    reply.code = ((status: number) => {
      statusCode = status;
      return originalCode(status);
    }) as FastifyReply["code"];

    reply.header = ((name: string, value: unknown) => {
      headers[String(name).toLowerCase()] = String(value);
      return originalHeader(name, value as string);
    }) as FastifyReply["header"];

    reply.send = ((payload?: unknown) => {
      if (!settled) {
        settled = true;
        let body = "";
        if (typeof payload === "string") body = payload;
        else if (Buffer.isBuffer(payload)) body = payload.toString("utf8");
        else if (payload !== undefined) {
          body = JSON.stringify(payload);
          headers["content-type"] =
            headers["content-type"] ?? "application/json; charset=utf-8";
        }
        resolve({ statusCode, headers, body });
      }
      return originalSend(payload);
    }) as FastifyReply["send"];

    Promise.resolve()
      .then(() => handler.call(thisArg, request, reply))
      .then((value) => {
        // Fastify may return the payload directly.
        if (!settled && value !== undefined && !reply.sent) {
          settled = true;
          const body =
            typeof value === "string" ? value : JSON.stringify(value);
          headers["content-type"] =
            headers["content-type"] ?? "application/json; charset=utf-8";
          resolve({ statusCode, headers, body });
          return originalSend(value);
        }
        if (!settled && reply.sent) {
          settled = true;
          resolve({ statusCode, headers, body: "" });
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
