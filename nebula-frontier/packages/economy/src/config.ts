import { ECONOMY, parseBaseUnits } from "@nebula/config";
import type { EconomyConfigDef } from "@nebula/shared";
import { withSerializableTx, type Db, type DbOrTx } from "@nebula/database";
import { toJson } from "./util.js";

/** Risk thresholds & bot heuristics (economy.json "risk"). */
export type RiskConfig = EconomyConfigDef["risk"];

/** Values the controller / admins adjust at runtime (EconomyConfig rows "runtime.*"). */
export interface RuntimeEconomyState {
  /** Admin override of the base emission rate (still hard-capped by maxRewardRate). */
  rewardRateOverride: number | null;
  /** Controller throttle (inflation response). 1 = no throttle. */
  throttleMultiplier: number;
  /** Activity multiplier computed by the controller from DAU trend. */
  activityMultiplier: number;
}

/** economy.json (money as exact bigint base units) + runtime controller state. */
export type EconomyConfig = EconomyConfigDef & {
  runtime: RuntimeEconomyState;
};

const RUNTIME_DEFAULTS: RuntimeEconomyState = { rewardRateOverride: null, throttleMultiplier: 1, activityMultiplier: 1 };

export function defaultEconomyConfig(): EconomyConfig {
  return { ...structuredClone(ECONOMY), runtime: { ...RUNTIME_DEFAULTS } };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Path segments that would reach Object.prototype (prototype pollution). */
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string;
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1] as string;
  const existing = cur[last];
  cur[last] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/**
 * Rebuilds `value`, applying `fn` to every leaf whose counterpart in `template` (the defaults) is a
 * bigint money amount. Other leaves are returned unchanged. Used to parse overrides (DB rows may hold
 * decimal strings or, from older rows, JSON numbers) into bigint and to serialize them back to JSON.
 */
function mapMoneyLeaves(template: unknown, value: unknown, fn: (v: unknown) => unknown): unknown {
  if (typeof template === "bigint") return fn(value);
  if (!isPlainObject(template) || !isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
    out[k] = Object.hasOwn(template, k) ? mapMoneyLeaves(template[k], v, fn) : v;
  }
  return out;
}

/** Money leaf → bigint when it is a valid base-unit amount; invalid input is kept for validateEconomyConfig to report. */
const moneyToBigint = (v: unknown): unknown => parseBaseUnits(v) ?? v;
/** Money leaf → decimal integer string (JSON-safe, precision-preserving) for EconomyConfig rows and audit logs. */
const moneyToJson = (v: unknown): unknown => parseBaseUnits(v)?.toString() ?? v;

/** Validates the merged config. Returns a list of human readable errors (empty = valid). */
export function validateEconomyConfig(cfg: EconomyConfig): string[] {
  const errs: string[] = [];
  const num = (v: unknown, name: string, min = 0, max = Number.POSITIVE_INFINITY) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) errs.push(`${name} must be a number in [${min}, ${max}]`);
  };
  // Money is exact integer base units (bigint after parsing): a value that failed to parse (fractional,
  // negative, unsafe number, non-decimal string) must never reach the controller's bigint math.
  const units = (v: unknown, name: string, min = 0n) => {
    if (typeof v !== "bigint" || v < min) errs.push(`${name} must be an integer >= ${min} (base units)`);
  };
  const count = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) errs.push(`${name} must be a non-negative integer`);
  };
  const alloc = Object.values(cfg.rewardAllocation);
  alloc.forEach((v, i) => num(v, `rewardAllocation[${i}]`, 0, 1));
  const allocSum = alloc.reduce((s, v) => s + v, 0);
  if (allocSum > 1 + 1e-9) errs.push(`rewardAllocation sums to ${allocSum.toFixed(4)} (> 100%)`);
  num(cfg.rewardBudgetRatio, "rewardBudgetRatio", 0, 1);
  const reserveSum = cfg.rewardBudgetRatio + cfg.treasuryReserveRatio + cfg.operatingReserveRatio + cfg.emergencyReserveRatio;
  if (reserveSum > 1 + 1e-9) errs.push(`reward + reserve ratios sum to ${reserveSum.toFixed(4)} (> 100%)`);
  num(cfg.emission.baseRate, "emission.baseRate", 0, 1);
  num(cfg.emission.maxRewardRate, "emission.maxRewardRate", 0, 1);
  if (cfg.emission.baseRate > cfg.emission.maxRewardRate) errs.push("emission.baseRate must be <= emission.maxRewardRate");
  units(cfg.minTreasuryReserve, "minTreasuryReserve");
  units(cfg.emission.rewardUnitLamports, "emission.rewardUnitLamports", 1n);
  for (const [k, v] of Object.entries(cfg.caps)) units(v, `caps.${k}`, 1n);
  const w = cfg.withdrawal;
  for (const k of ["min", "max", "dailyLimit", "reviewThreshold"] as const) units(w[k], `withdrawal.${k}`);
  for (const k of ["cooldownMinutes", "minAccountAgeHours", "walletChangeLockHours"] as const) count(w[k], `withdrawal.${k}`);
  for (const [k, v] of Object.entries(cfg.sinks)) units(v, `sinks.${k}`);
  units(cfg.circuitBreaker.depositSpikeFloorLamports, "circuitBreaker.depositSpikeFloorLamports");
  units(cfg.tokenomics.maxSupply, "tokenomics.maxSupply", 1n);
  num(cfg.emission.activityMultiplierMax, "emission.activityMultiplierMax", 0, 10);
  num(cfg.emission.seasonMultiplier, "emission.seasonMultiplier", 0, 10);
  const th = cfg.treasuryHealth;
  if (!(th.healthy > th.watch && th.watch > th.warning && th.warning > 0)) errs.push("treasuryHealth thresholds must satisfy healthy > watch > warning > 0");
  for (const [k, v] of Object.entries(th.multipliers)) num(v, `treasuryHealth.multipliers.${k}`, 0, 1);
  const caps = cfg.caps;
  if (typeof caps.daily === "bigint" && typeof caps.weekly === "bigint" && typeof caps.season === "bigint"
    && !(caps.daily > 0n && caps.daily <= caps.weekly && caps.weekly <= caps.season)) errs.push("caps must satisfy 0 < daily <= weekly <= season");
  if (typeof w.min === "bigint" && typeof w.max === "bigint" && typeof w.dailyLimit === "bigint"
    && !(w.min > 0n && w.min <= w.max && w.max <= w.dailyLimit)) errs.push("withdrawal must satisfy 0 < min <= max <= dailyLimit");
  const f = cfg.fees;
  units(f.withdrawalFlat, "fees.withdrawalFlat");
  units(f.estimatedNetworkFee, "fees.estimatedNetworkFee");
  for (const k of ["marketplace", "auctionListing", "auctionSale", "auctionCancellation", "withdrawalServicePercent", "tradeTax"] as const) num(f[k], `fees.${k}`, 0, 0.5);
  const tok = Object.values(cfg.tokenomics.allocation).reduce((s, v) => s + v, 0);
  if (Math.abs(tok - 1) > 1e-9) errs.push("tokenomics.allocation must sum to 100%");
  if (cfg.runtime.rewardRateOverride !== null) num(cfg.runtime.rewardRateOverride, "runtime.rewardRateOverride", 0, 1);
  num(cfg.runtime.throttleMultiplier, "runtime.throttleMultiplier", 0, 1);
  num(cfg.runtime.activityMultiplier, "runtime.activityMultiplier", 0, 10);
  if (!(cfg.risk.mediumScore < cfg.risk.highScore && cfg.risk.highScore < cfg.risk.criticalScore)) errs.push("risk score thresholds must ascend");
  return errs;
}

export class EconomyConfigError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Invalid economy config: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

/**
 * Apply a list of (dot-path key, value) overrides to defaults. Money leaves are parsed to bigint
 * (decimal strings, and safe-integer numbers from rows written before amounts were strings).
 */
export function applyOverrides(rows: { key: string; value: unknown }[], base = defaultEconomyConfig()): EconomyConfig {
  const template = defaultEconomyConfig();
  const out = base as unknown as Record<string, unknown>;
  const sorted = [...rows].sort((a, b) => a.key.split(".").length - b.key.split(".").length);
  for (const r of sorted) {
    const path = r.key.split(".");
    setPath(out, path, mapMoneyLeaves(getPath(template, path), r.value, moneyToBigint));
  }
  return out as unknown as EconomyConfig;
}

/** economy.json defaults merged with EconomyConfig DB rows (dot-path keys, e.g. "caps.daily"). */
export async function loadEconomyConfig(db: DbOrTx): Promise<EconomyConfig> {
  const rows = await db.economyConfig.findMany({ select: { key: true, value: true } });
  return applyOverrides(rows);
}

/** Keys admins may set: any existing leaf/subtree of the defaults (plus runtime.*). */
export function isKnownConfigKey(key: string): boolean {
  if (!/^[A-Za-z0-9_.]+$/.test(key)) return false;
  const path = key.split(".");
  if (path.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) return false;
  return getPath(defaultEconomyConfig(), path) !== undefined;
}

/**
 * `b` (the new value) must have the shape of `a` (the default). Subtrees are compared leaf by leaf with
 * the same key set, so `{ fees: { marketplace: "0.1" } }` cannot slip a string past a numeric leaf.
 * Money leaves (bigint defaults) accept a decimal integer string or a non-negative safe-integer number.
 */
function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint") return parseBaseUnits(b) !== null;
  if (a === null || b === null) return true; // nullable runtime fields
  if (Array.isArray(a)) return Array.isArray(b);
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && kb.every((k) => Object.hasOwn(a, k) && sameShape(a[k], b[k]));
  }
  return typeof a === typeof b;
}

/**
 * Admin update of one config key. Validates the key exists, the value has the right type and the
 * resulting merged config is valid (e.g. reward allocation <= 100%). Writes the row and an AuditLog
 * entry with old/new value atomically.
 */
export async function updateEconomyConfig(
  db: Db,
  key: string,
  value: unknown,
  adminId: string | null,
  reason: string,
  meta: { ip?: string | null; requestId?: string | null; actorType?: string } = {}
): Promise<{ config: EconomyConfig; oldValue: unknown; newValue: unknown }> {
  if (!isKnownConfigKey(key)) throw new EconomyConfigError([`Unknown economy config key "${key}"`]);
  if (!reason || reason.trim().length < 3) throw new EconomyConfigError(["A reason is required"]);
  const defaults = defaultEconomyConfig();
  const defVal = getPath(defaults, key.split("."));
  if (!sameShape(defVal, value)) throw new EconomyConfigError([`Value for "${key}" has the wrong type`]);
  // Stored form: money leaves as decimal integer strings (JSON cannot hold bigint; numbers lose precision).
  const stored = mapMoneyLeaves(defVal, value, moneyToJson);

  // SERIALIZABLE: two concurrent updates (e.g. raising two allocation buckets) must not both
  // validate against the same old rows and together produce an invalid config.
  return withSerializableTx(db, async (tx) => {
    const rows = await tx.economyConfig.findMany({ select: { key: true, value: true } });
    const current = applyOverrides(rows);
    const oldValue = getPath(current, key.split("."));
    const next = applyOverrides([...rows.filter((r) => r.key !== key), { key, value: stored }]);
    const errors = validateEconomyConfig(next);
    if (errors.length) throw new EconomyConfigError(errors);
    await tx.economyConfig.upsert({
      where: { key },
      create: { key, value: stored as Json as object, updatedBy: adminId },
      update: { value: stored as Json as object, updatedBy: adminId }
    });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        actorType: meta.actorType ?? (adminId ? "ADMIN" : "SYSTEM"),
        action: "ECONOMY_CONFIG_UPDATE",
        targetType: "EconomyConfig",
        targetId: key,
        oldValue: toJson(oldValue),
        newValue: toJson(stored),
        reason,
        ip: meta.ip ?? null,
        requestId: meta.requestId ?? null
      }
    });
    return { config: next, oldValue, newValue: stored };
  });
}
