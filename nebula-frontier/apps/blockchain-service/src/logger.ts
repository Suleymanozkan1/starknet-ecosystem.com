/** Minimal structured logger. Never pass secrets to it; `redact` strips known secret-bearing keys. */
const SECRET_KEYS = /secret|private|token|password|seed|keypair/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
  if (v instanceof Error) return { message: v.message, name: v.name };
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(x, depth + 1);
  return out;
}

function line(level: string, msg: string, data?: Record<string, unknown>): string {
  return JSON.stringify({ level, time: new Date().toISOString(), service: "blockchain-service", msg, ...(data ? (redact(data) as object) : {}) });
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.info(line("info", msg, data)),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(line("warn", msg, data)),
  error: (msg: string, data?: Record<string, unknown>) => console.error(line("error", msg, data))
};
