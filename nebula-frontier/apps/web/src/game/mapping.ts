/** Maps @nebula/game-client HudState / GameUiEvent onto the React HUD view model. */
import { QUESTS_BY_ID, SHIPS } from "@nebula/config";
import type { GameUiEvent, HudState } from "@nebula/game-client";
import type { HudEvent, HudSkill, HudView } from "./hudModel.js";
import { currentLanguage, fmtNum, tNow, translateServerText } from "../lib/i18n.js";
import { objectiveLabel } from "../lib/gameMeta.js";

const ABILITY_KIND = new Map<string, string>(SHIPS.flatMap((s) => s.abilities.map((a) => [a.id, a.kind] as const)));

/** Session facts only delivered through events (station name/services, killer, repair cost, boss phase). */
export interface SessionFacts {
  docked: { stationId: string; name: string; services: string[] } | null;
  death: { killer: string | null; repairCost: number; at: number } | null;
  bossPhase: { name: string; layer: string; phase: number } | null;
}

export function newSessionFacts(): SessionFacts {
  return { docked: null, death: null, bossPhase: null };
}

type QuestDef = NonNullable<ReturnType<typeof QUESTS_BY_ID.get>>;

/**
 * Tracker text for the current objective. English keeps the game client's own text; Turkish rebuilds it
 * from the quest definition ("Yok et: Korsan Akıncı 3/10").
 */
function questText(q: NonNullable<HudState["questObjective"]>, qdef: QuestDef | undefined): string {
  if (currentLanguage() === "en" || !qdef) return q.text;
  const idx = qdef.objectives.findIndex((o, i) => (q.progress[i] ?? 0) < o.count);
  const i = idx < 0 ? 0 : idx;
  const o = qdef.objectives[i];
  if (!o) return q.text;
  return `${objectiveLabel(o.type, o.target)} ${Math.min(o.count, q.progress[i] ?? 0)}/${o.count}`;
}

export function mapHud(s: HudState, facts: SessionFacts): HudView {
  const skills: HudSkill[] = s.cooldowns.map((c) => {
    const k = c.kind === "MODULE" ? "MODULE" : ABILITY_KIND.get(c.id) === "ULTIMATE" ? "ULTIMATE" : "ABILITY";
    return { slot: c.slot, key: c.hotkey, name: c.name, kind: k, cooldownMs: c.cooldownMs, remainingMs: c.remainingMs, energyCost: c.energyCost, active: false };
  });
  const station = s.prompts.find((p) => p.kind === "STATION" && p.enabled && !s.docked);
  const q = s.questObjective;
  const qdef = q ? QUESTS_BY_ID.get(q.questId) : undefined;
  return {
    mapId: s.mapId,
    connection: s.status === "connected" ? "connected" : s.status === "reconnecting" ? "reconnecting" : s.status === "connecting" || s.status === "switching" || s.status === "idle" ? "connecting" : s.connected ? "connected" : "disconnected",
    pingMs: s.ping > 0 ? Math.round(s.ping) : null,
    hull: { value: s.hull, max: Math.max(1, s.maxHull) },
    shield: { value: s.shield, max: Math.max(1, s.maxShield) },
    energy: { value: s.energy, max: Math.max(1, s.maxEnergy) },
    speed: s.speed,
    maxSpeed: s.maxSpeed,
    ammo: s.ammo.filter((a) => a.group === "SECONDARY").map((a) => ({ label: a.name, count: a.count })),
    target: s.target
      ? {
          id: s.target.id, name: s.target.clanTag ? `[${s.target.clanTag}] ${s.target.name}` : s.target.name, kind: s.target.kind, level: s.target.level,
          hull: { value: s.target.hull, max: Math.max(1, s.target.maxHull) }, shield: { value: s.target.shield, max: Math.max(1, s.target.maxShield) },
          distance: s.target.distance, faction: s.target.faction || null, hostile: s.target.hostile,
        }
      : null,
    skills,
    quest: q
      ? {
          name: q.name,
          objectives: (qdef?.objectives ?? [{ count: 1 }]).map((o, i) => ({ label: i === 0 ? questText(q, qdef) : tNow("hud.objectiveN", { n: i + 1 }), progress: q.progress[i] ?? 0, count: o.count })),
        }
      : null,
    squad: s.squad.map((m) => ({ id: m.id, name: m.name, hull: { value: m.hullPct, max: 1 }, shield: { value: m.shieldPct, max: 1 }, dead: m.hullPct <= 0 })),
    boss: s.boss
      ? {
          name: s.boss.name, hull: { value: s.boss.hullPct, max: 1 }, shield: { value: 0, max: 1 }, phase: s.boss.phase,
          phaseName: facts.bossPhase?.name ?? "", layer: facts.bossPhase?.layer ?? "", phases: 0,
        }
      : null,
    dockPrompt: station ? { stationId: station.id, name: station.label.replace(/^Dock at /, "") } : null,
    docked: s.docked ? (facts.docked ?? { stationId: "", name: tNow("hud.station"), services: [] }) : null,
    dead: s.dead ? { repairCost: facts.death?.repairCost ?? 0, killer: facts.death?.killer ?? null, respawnAt: null } : null,
    zone: s.zone,
  };
}

/** Converts a game event to a HUD event and updates session facts. Returns null for events the HUD ignores. */
export function mapEvent(e: GameUiEvent, facts: SessionFacts): HudEvent | null {
  switch (e.type) {
    case "damage":
      // Damage numbers are drawn by the game client's overlay; the shell only needs hit feedback (haptics).
      return e.toLocal || e.fromLocal ? { type: "hit", incoming: e.toLocal, crit: e.crit } : null;
    case "kill_feed": return { type: "killfeed", killer: e.data.killer, victim: e.data.victim, weapon: e.data.weapon, pvp: e.data.pvp };
    case "level_up": return { type: "levelup", level: e.level };
    case "loot_pickup": {
      const first = e.data.items[0];
      const label = first ? `${first.quantity > 1 ? `${first.quantity}× ` : ""}${first.name}${e.data.items.length > 1 ? ` +${e.data.items.length - 1}` : ""}` : e.data.credits ? tNow("common.credits") : tNow("inv.resources");
      return { type: "loot", label, rarity: first?.rarity ?? "COMMON", credits: e.data.credits };
    }
    case "reward": {
      const r = e.data;
      const parts = [r.xp ? tNow("event.xp", { n: r.xp }) : "", r.honor ? tNow("event.honor", { n: r.honor }) : "", r.credits ? tNow("event.credits", { n: r.credits }) : ""].filter(Boolean);
      return { type: "reward", text: `${translateServerText(r.reason)}${parts.length ? ` · ${parts.join(" · ")}` : ""}${r.cryptoEligible ? ` · ${tNow("reward.cryptoEligible")}` : ""}` };
    }
    case "notice": return { type: "notice", level: e.data.level, text: translateServerText(e.data.text) };
    case "error": return { type: "notice", level: "error", text: translateServerText(e.message) };
    case "boss_phase":
      facts.bossPhase = { name: e.name, layer: e.layer, phase: e.phase };
      return { type: "boss_phase", name: e.name, phase: e.phase };
    case "event_started": return { type: "notice", level: "warn", text: tNow("event.started", { name: e.name }) };
    case "quest_complete": return { type: "notice", level: "success", text: tNow("event.missionComplete", { name: e.name }) };
    case "wave": return { type: "notice", level: "warn", text: tNow("event.wave", { wave: e.wave, total: e.total, name: e.name }) };
    case "death":
      facts.death = { killer: e.killerName ?? null, repairCost: e.repairCost ?? 0, at: Date.now() };
      return null;
    case "respawn":
      facts.death = null;
      return e.repairCost > 0 ? { type: "notice", level: "info", text: tNow("event.repaired", { n: fmtNum(e.repairCost) }) } : null;
    case "docked":
      facts.docked = { stationId: e.stationId, name: e.stationName, services: e.services };
      return null;
    case "undocked":
      facts.docked = null;
      return null;
    case "map_transition":
      if (e.phase === "start" || e.phase === "loading") return { type: "jump", mapId: e.mapId, phase: "start" };
      if (e.phase === "failed") return { type: "notice", level: "error", text: e.error ? translateServerText(e.error) : tNow("event.jumpFailed") };
      return { type: "jump", mapId: e.mapId, phase: "end" };
    case "chat": return { type: "chat", channel: e.channel, from: e.from, text: e.text, at: e.at };
    case "connection":
      return e.status === "reconnecting" ? { type: "notice", level: "warn", text: tNow("event.reconnecting") } : null;
    default:
      return null;
  }
}
