/**
 * Error helpers mirroring apps/api/src/errors.ts, thrown as the client's ApiRequestError so callers see
 * exactly what a real API error would produce (status, code, message, details).
 */
import { ApiRequestError } from "../lib/http.js";

export const badRequest = (code: string, message: string, details?: unknown): ApiRequestError => new ApiRequestError(400, code, message, details);
export const unauthorized = (message = "Authentication required", code = "UNAUTHORIZED"): ApiRequestError => new ApiRequestError(401, code, message);
export const forbidden = (message = "Forbidden", code = "FORBIDDEN"): ApiRequestError => new ApiRequestError(403, code, message);
export const notFound = (what = "Resource", code = "NOT_FOUND"): ApiRequestError => new ApiRequestError(404, code, `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown): ApiRequestError => new ApiRequestError(409, code, message, details);
export const insufficientBalance = (): ApiRequestError => new ApiRequestError(400, "INSUFFICIENT_BALANCE", "Insufficient balance");

/** Real-money / on-chain / multi-player features that a browser-only demo cannot provide. */
export const demoDisabled = (message = "This action is disabled in the demo"): ApiRequestError => new ApiRequestError(403, "DEMO_DISABLED", message);
export const notInDemo = (): ApiRequestError => new ApiRequestError(501, "NOT_IN_DEMO", "This feature is not available in the demo");

/** Structural view of a zod schema (avoids a direct zod dependency in apps/web). */
export interface ParseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/** Same contract as the API's `app.parse`: 400 VALIDATION_ERROR with `{ path, message }[]` details. */
export function parse<T>(schema: ParseSchema<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  throw new ApiRequestError(
    400,
    "VALIDATION_ERROR",
    "Invalid request",
    res.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  );
}
