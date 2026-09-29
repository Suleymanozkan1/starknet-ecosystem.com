/** Minimal method + path-pattern router for the demo backend (`/api/ships/:id/loadouts/:loadoutId`). */
import { currentAccount } from "./account.js";
import { unauthorized } from "./errors.js";
import type { DemoAccount } from "./state.js";

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface Ctx {
  params: Record<string, string>;
  query: Query;
  body: unknown;
}

export type Handler = (c: Ctx) => unknown;

interface Route { method: string; parts: string[]; handler: Handler }

const routes: Route[] = [];

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method: method.toUpperCase(), parts: split(pattern), handler });
}

export function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const segs = split(path);
  const m = method.toUpperCase();
  for (const r of routes) {
    if (r.method !== m || r.parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i] ?? "";
      const s = segs[i] ?? "";
      if (p.startsWith(":")) {
        try {
          params[p.slice(1)] = decodeURIComponent(s);
        } catch {
          ok = false;
          break;
        }
      } else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/** The signed-in demo pilot, or 401 exactly like `app.authenticate`. */
export function requireAccount(): DemoAccount {
  const acc = currentAccount();
  if (!acc) throw unauthorized();
  return acc;
}

/** Query value as a string (undefined when absent/empty) — what the API's zod query schemas receive. */
export function q(query: Query, key: string): string | undefined {
  const v = query[key];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

/** Query object with empty values dropped (same as URLSearchParams building in lib/http.ts). */
export function cleanQuery(query: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  return out;
}
