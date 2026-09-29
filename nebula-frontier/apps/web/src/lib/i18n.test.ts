import { afterEach, describe, expect, it } from "vitest";
import { ACHIEVEMENTS, BLUEPRINTS, DRONES, EVENTS, FACTIONS, ITEMS, MAPS, MODULES, PROGRESSION, QUESTS, SEASONS, SHIPS, SHOP, WEAPONS } from "@nebula/config";
import { formatAmount, formatDuration } from "@nebula/game-ui";
import { EN } from "./i18n/en.js";
import type { TKey } from "./i18n/en.js";
import { TR } from "./i18n/tr.js";
import { ENUM_TR, enumKey } from "./i18n/enums.js";
import { SERVER_TEXT_TR, serverTextTr } from "./i18n/serverText.js";
import { ABILITY_DESC_TR, ACHIEVEMENT_DESC_TR, EVENT_DESC_TR, FACTION_TR, ITEM_DESC_TR, MODULE_DESC_TR, QUEST_DESC_TR, SEASON_THEME_TR, SHIP_DESC_TR, SHOP_DESC_TR, itemDescTr } from "./i18n/content.js";
import { contentText, enumLabel, translate, translateServerText } from "./i18n.js";
import { useSettings } from "../store/settings.js";

/**
 * Keys whose Turkish text is intentionally identical to English: proper nouns, product/brand names,
 * units / abbreviations used as-is in Turkish gaming UIs, and pure placeholder templates.
 */
const SAME_IN_TR = new Set<TKey>([
  "nav.hangar", // "Hangar" is the Turkish word too
  "common.devnet", // Solana network name
  "wallet.eyebrow", // "Solana devnet"
  "stat.element", // "Element" is the Turkish word too
  "zone.PVP", "lb.pvp", "lb.pve", // PvP / PvE genre terms
  "zone.BOSS", // "Boss" is used as-is in Turkish games
  "room.arena", // "Arena" is the Turkish word too
  "bp.premium", // product tier name
  "settings.tier.ULTRA", // graphics preset name
  "settings.kbd.enter", // physical key label
  "settings.platform", // "Platform" is the Turkish word too
  "lb.pilot", "clan.pilot", "mail.pilot", // "Pilot" is the Turkish word too
  "mc.emp", // EMP weapon abbreviation
  "reward.sp", "reward.xp", "event.xp", // "{n} SP" / "{n} XP" unit templates
  "hangar.slotFilled", // "{label} {n}: {name}" placeholder-only template
]);

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
const INVESTMENT = /\bAPY\b|\bAPR\b|\bROI\b|interest|guaranteed return|passive income|daily profit|faiz|garanti|getiri|pasif gelir|günlük kâr|günlük kar\b|yatırım/i;

afterEach(() => useSettings.getState().set("language", "en"));

describe("i18n dictionaries (EN/TR)", () => {
  const keys = Object.keys(EN) as TKey[];

  it("has a non-empty Turkish translation for every English key", () => {
    const missing = keys.filter((k) => typeof TR[k] !== "string" || TR[k].trim() === "");
    expect(missing).toEqual([]);
    expect(Object.keys(TR).sort()).toEqual([...keys].sort());
  });

  it("translates every key (TR differs from EN) except the explicit allowlist", () => {
    const identical = keys.filter((k) => TR[k] === EN[k] && !SAME_IN_TR.has(k));
    expect(identical).toEqual([]);
    // The allowlist must not hide keys that are actually translated.
    const stale = [...SAME_IN_TR].filter((k) => TR[k] !== EN[k]);
    expect(stale).toEqual([]);
  });

  it("keeps the same {placeholders} in both languages", () => {
    const bad = keys.filter((k) => placeholders(EN[k]).join(",") !== placeholders(TR[k]).join(","));
    expect(bad).toEqual([]);
  });

  it("interpolates variables and falls back to English", () => {
    expect(translate("en", "nav.inventory")).toBe("Inventory");
    expect(translate("tr", "nav.inventory")).toBe("Envanter");
    expect(translate("tr", "common.levelN", { n: 12 })).toBe("Seviye 12");
    expect(translate("en", "shop.purchased", { name: "Wisp" })).toBe("Purchased Wisp");
    expect(translate("tr", "common.pct", { n: 45 })).toBe("%45");
  });

  it("uses no investment terminology in any language, content or server text", () => {
    const all = [
      ...Object.values(EN), ...Object.values(TR), ...Object.values(ENUM_TR), ...Object.values(SERVER_TEXT_TR),
      ...Object.values(SHOP_DESC_TR), ...Object.values(ITEM_DESC_TR), ...Object.values(QUEST_DESC_TR), ...Object.values(EVENT_DESC_TR),
      ...Object.values(ACHIEVEMENT_DESC_TR), ...Object.values(SHIP_DESC_TR), ...Object.values(ABILITY_DESC_TR), ...Object.values(MODULE_DESC_TR),
      ...Object.values(FACTION_TR).flatMap((f) => [f.motto, f.lore]),
    ];
    expect(all.filter((s) => INVESTMENT.test(s))).toEqual([]);
  });

  it("keeps the product name untranslated", () => {
    expect(TR["nav.homeLink"]).toContain("Nebula Frontier");
    expect(TR["landing.footer"]).toContain("Nebula Frontier");
  });
});

describe("enum labels", () => {
  it("covers every generic category / enum id used by the game data", () => {
    const ids = new Set<string>([
      ...SHIPS.flatMap((s) => [s.class, ...s.abilities.map((a) => a.kind), ...Object.keys(s.stats)]),
      ...WEAPONS.flatMap((w) => [w.type, w.slot, w.element]),
      ...MODULES.flatMap((m) => [m.kind, m.slot, ...Object.keys(m.passive)]),
      ...DRONES.flatMap((d) => [d.type, ...Object.keys(d.passivePerLevel)]),
      ...QUESTS.flatMap((q) => [q.type, ...q.objectives.map((o) => o.type)]),
      ...EVENTS.flatMap((e) => [e.type, ...e.rewards.map((r) => r.tier)]),
      ...ITEMS.map((i) => i.category),
      ...ACHIEVEMENTS.map((a) => a.category),
      ...BLUEPRINTS.map((b) => b.tier),
      ...MAPS.flatMap((m) => [...m.zones.map((z) => z.type), ...m.portals.map((p) => p.kind), ...m.stations.flatMap((s) => s.services)]),
      ...FACTIONS.flatMap((f) => Object.keys(f.bonus)),
      ...PROGRESSION.ranks.map((r) => r.id),
      "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "ANCIENT", "MYTHIC", "PROTOTYPE",
      "LEADER", "OFFICER", "VETERAN", "MEMBER", "RECRUIT", "HOURLY", "DAILY", "WEEKLY",
      "ACTIVE", "SOLD", "CANCELLED", "EXPIRED", "PENDING", "PENDING_REVIEW", "COMPLETED", "FAILED",
      "STANDARD", "ARROW", "TURTLE", "DIAMOND", "WHEEL", "PVP", "PVE", "TANK", "SPEED", "MINING", "BOSS", "RAID", "CUSTOM",
      "HULL_SKIN", "ENGINE_EFFECT", "ENGINE_COLOR", "SHIELD_COLOR", "SHIELD_EFFECT", "TRAIL", "WEAPON_SKIN", "DRONE_SKIN", "EXPLOSION",
    ]);
    const missing = [...ids].filter((id) => !ENUM_TR[enumKey(id)]);
    expect(missing).toEqual([]);
  });

  it("keeps English labels identical to the previous humanize() output", () => {
    expect(enumLabel("BATTLECRUISER")).toBe("Battlecruiser");
    expect(enumLabel("SHIP_PART")).toBe("Ship Part");
    useSettings.getState().set("language", "tr");
    expect(enumLabel("BATTLECRUISER")).toBe("Savaş Kruvazörü");
    expect(enumLabel("energy_Regen")).toBe("Enerji yenilenmesi");
    expect(enumLabel("SOMETHING_NEW")).toBe("Something New");
  });
});

describe("server / simulation texts", () => {
  const SIM_NOTICES = [
    "No dash ability equipped", "Move closer to pick up", "Repairs in progress", "Undock first", "Ability on cooldown", "Not enough energy",
    "Cargo hold full — dock to unload", "Station out of range", "Cannot dock during combat", "Cannot jump now", "Fly into the portal to jump",
    "Jump drive locked during combat", "Portal destination offline",
    "Demo mode: offline simulation — progress is kept in this browser only.",
  ];

  it("translates every offline-simulation notice", () => {
    expect(SIM_NOTICES.filter((s) => serverTextTr(s) === null)).toEqual([]);
  });

  it("translates patterned messages with names and numbers", () => {
    expect(serverTextTr("Demo access: Orion Belt normally requires level 12")).toBe("Demo erişimi: Orion Belt normalde seviye 12 gerektirir");
    expect(serverTextTr("Destroyed Corsair Raider")).toBe("Yok edildi: Corsair Raider");
    expect(serverTextTr("Requires level 7")).toBe("Seviye 7 gerekli");
    expect(serverTextTr("Listing not found")).toBe("Listing bulunamadı");
    expect(serverTextTr("Level 5!")).toBe("Seviye 5!");
    expect(serverTextTr("+1,200 credits")).toBe("+1,200 kredi");
  });

  it("is a no-op in English and for unknown texts", () => {
    expect(translateServerText("Undock first")).toBe("Undock first");
    useSettings.getState().set("language", "tr");
    expect(translateServerText("Undock first")).toBe("Önce istasyondan ayrıl");
    expect(translateServerText("Some brand new server message")).toBe("Some brand new server message");
  });
});

describe("game content prose", () => {
  it("has Turkish lore/description for every faction, event, quest, achievement, module and ship description", () => {
    const missing = [
      ...FACTIONS.filter((f) => !FACTION_TR[f.id]).map((f) => f.id),
      ...EVENTS.filter((e) => e.description && !EVENT_DESC_TR[e.id]).map((e) => e.id),
      ...QUESTS.filter((q) => q.description && !QUEST_DESC_TR[q.id]).map((q) => q.id),
      ...ACHIEVEMENTS.filter((a) => a.description && !ACHIEVEMENT_DESC_TR[a.id]).map((a) => a.id),
      ...MODULES.filter((m) => m.description && !MODULE_DESC_TR[m.id]).map((m) => m.id),
      ...SHIPS.filter((s) => s.description && !SHIP_DESC_TR[s.id]).map((s) => s.id),
      ...SHIPS.flatMap((s) => s.abilities).filter((a) => a.description && !ABILITY_DESC_TR[a.id]).map((a) => a.id),
      ...ITEMS.filter((i) => i.description && itemDescTr(i.id, i.description) === null).map((i) => i.id),
      ...SHOP.filter((p) => p.description && !SHOP_DESC_TR[p.id]).map((p) => p.id),
      ...SEASONS.filter((x) => x.theme && !SEASON_THEME_TR[x.theme]).map((x) => x.id),
    ];
    expect(missing).toEqual([]);
  });

  it("returns config text in English and the translation in Turkish", () => {
    const f = FACTIONS[0]!;
    expect(contentText("factionMotto", f.id, f.motto)).toBe(f.motto);
    useSettings.getState().set("language", "tr");
    expect(contentText("factionMotto", f.id, f.motto)).toBe(FACTION_TR[f.id]?.motto);
  });
});

describe("UI kit locale", () => {
  it("formats numbers and durations per language", () => {
    expect(formatAmount("1234567", "CREDITS")).toBe("1,234,567");
    expect(formatDuration(90 * 60_000, { showSeconds: false })).toBe("1h 30m");
    useSettings.getState().set("language", "tr");
    expect(formatAmount("1234567", "CREDITS")).toBe("1.234.567");
    expect(formatDuration(90 * 60_000, { showSeconds: false })).toBe("1sa 30dk");
    useSettings.getState().set("language", "en");
    expect(formatAmount("1234567", "CREDITS")).toBe("1,234,567");
  });
});
