import { formatUnits } from "@nebula/shared";

export const LAMPORTS = 1_000_000_000;
/** Lamports (string/bigint/number) → "1,234.5678 SOL" style string. */
export function sol(v: string | number | bigint | null | undefined, digits = 4): string {
  if (v === null || v === undefined) return "—";
  try {
    const n = typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);
    const s = formatUnits(n, 9, digits);
    const [w = "0", f] = s.split(".");
    return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${f ? `.${f}` : ""}`;
  } catch {
    return "—";
  }
}
export function int(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return "—";
  try {
    return BigInt(typeof v === "number" ? Math.trunc(v) : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  } catch {
    return "—";
  }
}
export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}
export function short(s: string | null | undefined, n = 6): string {
  if (!s) return "—";
  return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}
