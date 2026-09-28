/**
 * Uniform error model. Every error response has the `ApiError` shape from @nebula/shared:
 * `{ error: { code, message, details?, requestId } }`. Stack traces never leave the server.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ApiError } from "@nebula/shared";
import { LedgerError } from "@nebula/database";
import { ZodError } from "zod";

export class ApiHttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiHttpError(400, code, message, details);
export const unauthorized = (message = "Authentication required", code = "UNAUTHORIZED") => new ApiHttpError(401, code, message);
export const forbidden = (message = "Forbidden", code = "FORBIDDEN") => new ApiHttpError(403, code, message);
export const notFound = (what = "Resource", code = "NOT_FOUND") => new ApiHttpError(404, code, `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiHttpError(409, code, message, details);
export const unavailable = (code: string, message: string) => new ApiHttpError(503, code, message);

export function zodDetails(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

function body(code: string, message: string, requestId: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }), requestId } };
}

interface PrismaLikeError { code?: string; meta?: unknown; name?: string }

/** Map any thrown value to (status, ApiError). */
export function toApiError(err: unknown, requestId: string, isProd: boolean): { status: number; payload: ApiError } {
  if (err instanceof ApiHttpError) {
    return { status: err.statusCode, payload: body(err.code, err.message, requestId, err.details) };
  }
  if (err instanceof ZodError) {
    return { status: 400, payload: body("VALIDATION_ERROR", "Invalid request", requestId, zodDetails(err)) };
  }
  if (err instanceof LedgerError) {
    const status = err.code === "INSUFFICIENT_BALANCE" ? 400 : err.code === "NOT_FOUND" ? 404 : 400;
    // Ledger messages contain internal account keys; expose only the code.
    const message = err.code === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : "Ledger operation rejected";
    return { status, payload: body(err.code, message, requestId) };
  }
  const fe = err as FastifyError & PrismaLikeError;
  if (fe?.code === "P2002") return { status: 409, payload: body("CONFLICT", "Resource already exists", requestId) };
  if (fe?.code === "P2025") return { status: 404, payload: body("NOT_FOUND", "Resource not found", requestId) };
  if (fe?.code === "P2034") return { status: 409, payload: body("TX_CONFLICT", "Concurrent update, please retry", requestId) };
  if (fe?.validation) {
    return { status: 400, payload: body("VALIDATION_ERROR", fe.message, requestId) };
  }
  const status = typeof fe?.statusCode === "number" ? fe.statusCode : 500;
  if (status === 429) return { status, payload: body("RATE_LIMITED", "Too many requests", requestId) };
  if (status >= 400 && status < 500) {
    const code = fe.code && /^FST_/.test(fe.code) ? "BAD_REQUEST" : (fe.code ?? "BAD_REQUEST");
    return { status, payload: body(code, fe.message || "Bad request", requestId) };
  }
  return {
    status: 500,
    payload: body("INTERNAL_ERROR", isProd ? "Internal server error" : String((err as Error)?.message ?? "Internal server error"), requestId),
  };
}

export function sendError(req: FastifyRequest, reply: FastifyReply, err: unknown, isProd: boolean): FastifyReply {
  const { status, payload } = toApiError(err, req.id, isProd);
  if (status >= 500) req.log.error({ err }, "request failed");
  else req.log.info({ code: payload.error.code, status }, "request rejected");
  return reply.status(status).send(payload);
}
