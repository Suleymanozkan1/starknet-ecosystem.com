/**
 * Low-level fetch wrapper implementing the cookie auth contract:
 *  - httpOnly cookies `nf_access` / `nf_refresh` are sent with `credentials: "include"` (tokens are never
 *    readable by JS and never stored in localStorage),
 *  - double-submit CSRF: header `x-nf-csrf` = readable cookie `nf_csrf` on every mutating request,
 *  - on 401 we call POST /api/auth/refresh exactly once (deduplicated across concurrent requests) and retry.
 */
import type { ApiError as ApiErrorBody } from "@nebula/shared";
import { DEMO_MODE } from "./demoMode.js";

export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
const CSRF_COOKIE = "nf_csrf";
const CSRF_HEADER = "x-nf-csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isApiError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

/**
 * When the API lives on another origin (native app), its `nf_csrf` cookie is not visible through
 * document.cookie; the API also returns the token in the `x-nf-csrf` response header / `csrfToken`
 * body field of auth responses, which we keep in memory only.
 */
let memoryCsrf: string | null = null;
export function rememberCsrf(token: string | null | undefined): void {
  if (token) memoryCsrf = token;
}

export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie ? document.cookie.split("; ") : [];
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}

function csrfToken(): string | null {
  return readCookie(CSRF_COOKIE) ?? memoryCsrf;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
/** Called when a request stays 401 after a refresh attempt (session is gone). */
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

let refreshInFlight: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  if (DEMO_MODE) return request<unknown>("POST", "/api/auth/refresh", { noRefresh: true }).then(() => true, () => false);
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: withCsrf({ "content-type": "application/json" }),
          body: "{}",
        });
        rememberCsrf(res.headers.get(CSRF_HEADER));
        return res.ok;
      } catch {
        return false;
      } finally {
        // Allow a new refresh on the next 401 wave.
        setTimeout(() => { refreshInFlight = null; }, 0);
      }
    })();
  }
  return refreshInFlight;
}

function withCsrf(headers: Record<string, string>): Record<string, string> {
  const t = csrfToken();
  return t ? { ...headers, [CSRF_HEADER]: t } : headers;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the refresh+retry dance (used by auth endpoints themselves). */
  noRefresh?: boolean;
}

function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ""}`;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = null;
  }
  const e = body?.error;
  return new ApiRequestError(
    res.status,
    e?.code ?? (res.status === 404 ? "NOT_FOUND" : `HTTP_${res.status}`),
    e?.message ?? (res.statusText || "Request failed"),
    e?.details,
    e?.requestId,
  );
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (DEMO_MODE) {
    const { demoRequest } = await import("../demo/mockApi.js");
    const data = await demoRequest(method, path, opts.query, opts.body);
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return data as T;
  }
  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method, credentials: "include", headers, ...(opts.signal ? { signal: opts.signal } : {}) };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    } else if (MUTATING.has(method)) {
      // Fastify rejects empty bodies with a JSON content-type; send an empty object instead.
      headers["content-type"] = "application/json";
      init.body = "{}";
    }
    init.headers = MUTATING.has(method) ? withCsrf(headers) : headers;
    return fetch(buildUrl(path, opts.query), init);
  };

  let res: Response;
  try {
    res = await doFetch();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiRequestError(0, "NETWORK_ERROR", "Cannot reach the Nebula Frontier servers. Check your connection.");
  }
  if (res.status === 401 && !opts.noRefresh) {
    const ok = await refreshSession();
    if (ok) res = await doFetch();
    if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
  }
  rememberCsrf(res.headers.get(CSRF_HEADER));
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  const data = JSON.parse(text) as T & { csrfToken?: string };
  if (data && typeof data === "object" && "csrfToken" in data) rememberCsrf(data.csrfToken);
  return data;
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T>("GET", path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}) => request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body === undefined ? {} : { body }),
};

/** Human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === "VALIDATION_ERROR" && Array.isArray(e.details) && e.details.length) {
      const first = e.details[0] as { path?: string; message?: string };
      return `${e.message}: ${first.path ? `${first.path} — ` : ""}${first.message ?? ""}`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Random idempotency key for purchases/withdrawals/deposits. */
export function idempotencyKey(prefix = "web"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
