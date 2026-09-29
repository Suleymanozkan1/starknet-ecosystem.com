import { useCallback } from "react";
import { setUiLocale } from "@nebula/game-ui";
import { useSettings } from "../store/settings.js";
import type { Language } from "../store/settings.js";
import { EN } from "./i18n/en.js";
import type { TKey } from "./i18n/en.js";
import { TR } from "./i18n/tr.js";
import { ENUM_TR, enumKey } from "./i18n/enums.js";
import { serverTextTr } from "./i18n/serverText.js";
import {
  ABILITY_DESC_TR, ACHIEVEMENT_DESC_TR, EVENT_DESC_TR, FACTION_TR, MODULE_DESC_TR, QUEST_DESC_TR, SEASON_THEME_TR, SHIP_DESC_TR, SHOP_DESC_TR, itemDescTr,
} from "./i18n/content.js";

export type { TKey } from "./i18n/en.js";
export { En, Rich } from "./i18n/rich.js";

export type TVars = Readonly<Record<string, string | number>>;
export type TFn = (key: TKey, vars?: TVars) => string;

const DICTS: Record<Language, Readonly<Record<TKey, string>>> = { en: EN, tr: TR };

function interpolate(s: string, vars?: TVars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translates `key` into `lang` (falls back to English, then to the key itself) and fills `{placeholders}`. */
export function translate(lang: Language, key: TKey, vars?: TVars): string {
  return interpolate(DICTS[lang][key] ?? EN[key] ?? key, vars);
}

/** Active UI language (outside React; components should use `useT` / `useLanguage` so they re-render on change). */
export function currentLanguage(): Language {
  return useSettings.getState().language;
}

/** Non-hook translation for event handlers, toasts and plain modules. */
export function tNow(key: TKey, vars?: TVars): string {
  return translate(currentLanguage(), key, vars);
}

export function useLanguage(): Language {
  return useSettings((s) => s.language);
}

/** Translation function bound to the current language; the component re-renders when the language changes. */
export function useT(): TFn {
  const lang = useLanguage();
  return useCallback((key: TKey, vars?: TVars) => translate(lang, key, vars), [lang]);
}

// ---------------------------------------------------------------------------------------------- formatting

/** BCP-47 locale for Intl / toLocaleString. English keeps the browser default (unchanged behaviour). */
export function numberLocale(lang: Language = currentLanguage()): string | undefined {
  return lang === "tr" ? "tr-TR" : undefined;
}

export function fmtNum(n: number | bigint, opts?: Intl.NumberFormatOptions): string {
  return typeof n === "bigint" ? n.toLocaleString(numberLocale()) : n.toLocaleString(numberLocale(), opts);
}

/** Fixed-point number (e.g. fee percentages). English output is identical to `n.toFixed(digits)`. */
export function fmtFixed(n: number, digits: number): string {
  if (currentLanguage() === "en") return n.toFixed(digits);
  return n.toLocaleString(numberLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

/** Localises the decimal separator of an already formatted plain decimal string (e.g. `formatUnits` output). */
export function fmtDecimalStr(s: string): string {
  return currentLanguage() === "tr" ? s.replace(".", ",") : s;
}

export function fmtDateTime(d: string | number | Date): string {
  return new Date(d).toLocaleString(numberLocale());
}

export function fmtTime(d: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleTimeString(numberLocale() ?? [], opts);
}

/** Locale-aware upper-casing (Turkish dotted/dotless i). */
export function upper(s: string): string {
  return s.toLocaleUpperCase(numberLocale());
}

// ---------------------------------------------------------------------------------------------- enums / server text

export function humanize(s: string): string {
  return s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turkish label of a generic enum id when the language is Turkish, otherwise `fallback`. */
export function enumText(v: string | null | undefined, fallback: string): string {
  if (!v || currentLanguage() === "en") return fallback;
  return ENUM_TR[enumKey(v)] ?? fallback;
}

/** Display label for a generic enum id: English = `humanize(v)` (as before), Turkish = translated label. */
export function enumLabel(v: string): string {
  return enumText(v, humanize(v));
}

/** Pilot rank label (rank ids such as "rank_cadet"); English keeps the provided fallback. */
export function rankLabel(id: string, fallback: string = id): string {
  return enumText(id, fallback);
}

/**
 * Translates English texts coming from the game server / offline simulation / REST backend
 * (notices, errors, notifications) into the active language. Unknown texts are returned unchanged.
 */
export function translateServerText(text: string): string;
export function translateServerText(text: string | null | undefined): string | null | undefined;
export function translateServerText(text: string | null | undefined): string | null | undefined {
  if (!text || currentLanguage() === "en") return text;
  return serverTextTr(text) ?? text;
}

// ---------------------------------------------------------------------------------------------- game content prose

export type ContentKind = "factionMotto" | "factionLore" | "ship" | "ability" | "module" | "item" | "quest" | "shop" | "achievement" | "event" | "seasonTheme";

function contentTr(kind: ContentKind, id: string, english: string): string | null {
  switch (kind) {
    case "factionMotto": return FACTION_TR[id]?.motto ?? null;
    case "factionLore": return FACTION_TR[id]?.lore ?? null;
    case "ship": return SHIP_DESC_TR[id] ?? null;
    case "ability": return ABILITY_DESC_TR[id] ?? null;
    case "module": return MODULE_DESC_TR[id] ?? null;
    case "item": return itemDescTr(id, english);
    case "quest": return QUEST_DESC_TR[id] ?? null;
    case "shop": return SHOP_DESC_TR[id] ?? null;
    case "achievement": return ACHIEVEMENT_DESC_TR[id] ?? null;
    case "event": return EVENT_DESC_TR[id] ?? null;
    case "seasonTheme": return SEASON_THEME_TR[english] ?? null;
  }
}

/**
 * Descriptive game-content text (lore, descriptions) for the active language. English returns the config
 * text unchanged; Turkish uses the translation table and falls back to the original for unknown ids.
 */
export function contentText(kind: ContentKind, id: string, english: string): string;
export function contentText(kind: ContentKind, id: string, english: string | null | undefined): string | null | undefined;
export function contentText(kind: ContentKind, id: string, english: string | null | undefined): string | null | undefined {
  if (!english || currentLanguage() === "en") return english;
  return contentTr(kind, id, english) ?? english;
}

/**
 * Shop product display name. Product names are proper nouns except generic currency packs
 * ("1,200 Gems"), which are localised ("1.200 Mücevher").
 */
export function productName(p: { name: string }): string {
  if (currentLanguage() === "en") return p.name;
  const gems = /^([\d,]+) Gems$/.exec(p.name);
  return gems?.[1] ? `${gems[1].replace(/,/g, ".")} ${TR["common.gems"]}` : p.name;
}

// ---------------------------------------------------------------------------------------------- UI kit locale

const RARITY_IDS = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "ANCIENT", "MYTHIC", "PROTOTYPE"] as const;

function applyUiLocale(lang: Language): void {
  if (lang === "en") {
    setUiLocale({});
    return;
  }
  setUiLocale({
    locale: "tr-TR",
    groupSeparator: ".",
    decimalSeparator: ",",
    compact: { thousand: "B", million: "Mn", billion: "Mr" },
    units: { day: "g", hour: "sa", minute: "dk" },
    ended: TR["common.ended"],
    close: TR["common.close"],
    rarity: Object.fromEntries(RARITY_IDS.map((r) => [r, (ENUM_TR[r] ?? r).toLocaleLowerCase("tr-TR")])),
    currencySymbols: { CREDITS: "KR", GEMS: "MÜC" },
  });
}

// Keep the UI kit in sync with the persisted language. Zustand notifies this module-level listener
// synchronously on `set`, before React re-renders subscribed components.
applyUiLocale(currentLanguage());
useSettings.subscribe((s, prev) => {
  if (s.language !== prev.language) applyUiLocale(s.language);
});
