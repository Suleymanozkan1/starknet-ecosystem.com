/**
 * Standalone dev page: `pnpm --filter @nebula/game-client dev` → http://localhost:5175
 * Log in through the web app first (cookies are shared on localhost); the page
 * requests a game ticket from the API (proxied /api) and joins the game server.
 *   ?server=ws://localhost:2567&map=map_aurora_prime&gfx=HIGH|MEDIUM|LOW|ULTRA|AUTO
 */
import { createGame, type GameUiEvent, type HudState } from "./index.js";
import type { GraphicsTier } from "@nebula/shared";

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById("status") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;
const logEl = document.getElementById("log") as HTMLDivElement;

function cookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

const gameServerUrl = params.get("server") ?? (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? `ws://${location.hostname}:2567`;

async function getTicket(mapId: string): Promise<{ ticket: string; mapId: string }> {
  const res = await fetch("/api/game/ticket", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "x-nf-csrf": cookie("nf_csrf") },
    body: JSON.stringify({ mapId }),
  });
  if (res.status === 401) throw new Error("Not logged in — sign in via the web app (http://localhost:5173) first.");
  if (!res.ok) throw new Error(`Ticket request failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { ticket: string; mapId: string };
  return { ticket: body.ticket, mapId: body.mapId };
}

function log(text: string, color = "#cfe3ff"): void {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.color = color;
  logEl.prepend(d);
  while (logEl.childElementCount > 14) logEl.lastElementChild?.remove();
}

function bar(v: number, max: number, color: string): string {
  const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
  return `<div class="bar"><i style="width:${pct}%;background:${color}"></i></div>`;
}

function renderHud(h: HudState): void {
  const cds = h.cooldowns.map((c) => `${c.hotkey}:${c.name}${c.remainingMs > 0 ? ` (${(c.remainingMs / 1000).toFixed(1)}s)` : ""}`).join(" · ");
  hudEl.innerHTML = `
    <b>${h.mapName}</b> · ${h.zone}${h.pvp ? " · PvP" : ""} · ${h.ping}ms · ${h.fps}fps · ${h.graphics}<br/>
    Lv ${h.level} · +${h.xpGained} XP · ${h.speed}/${Math.round(h.maxSpeed)} u/s ${h.boosting ? "BOOST" : ""}
    ${bar(h.shield, h.maxShield, "#4cc9f0")}${bar(h.hull, h.maxHull, "#52e07a")}${bar(h.energy, h.maxEnergy, "#ffd166")}
    ${h.target ? `Target: ${h.target.name} (${h.target.distance}u) ${h.target.inRange ? "IN RANGE" : ""}<br/>` : ""}
    ${h.questObjective ? `Quest: ${h.questObjective.text}<br/>` : ""}
    ${h.boss ? `Boss: ${h.boss.name} ${(h.boss.hullPct * 100).toFixed(0)}% · phase ${h.boss.phase}<br/>` : ""}
    <small>${cds}</small><br/>
    ${h.prompts.map((p) => `<span class="prompt">[${p.key}] ${p.label}${p.enabled ? "" : ` — ${p.reason ?? ""}`}</span>`).join("")}
  `;
}

function onEvent(e: GameUiEvent): void {
  switch (e.type) {
    case "kill_feed": log(`☠ ${e.data.killer} → ${e.data.victim}`, "#ff9a9a"); break;
    case "notice": log(e.data.text, e.data.level === "error" ? "#ff6b6b" : "#ffe08a"); break;
    case "reward": log(`+${e.data.xp} XP +${e.data.credits} CR (${e.data.reason})`, "#8cffb0"); break;
    case "level_up": log(`LEVEL UP → ${e.level}`, "#8cffb0"); break;
    case "death": log(`Destroyed${e.killerName ? ` by ${e.killerName}` : ""} — press R to respawn`, "#ff6b6b"); break;
    case "docked": log(`Docked at ${e.stationName}: ${e.services.join(", ")} (E to undock)`, "#9fe8ff"); break;
    case "map_transition": log(`Warp ${e.phase}: ${e.mapName}${e.error ? ` (${e.error})` : ""}`, "#b388ff"); break;
    case "connection": statusEl.textContent = e.status === "connected" ? "" : e.status; break;
    case "error": log(`${e.code}: ${e.message}`, "#ff6b6b"); break;
    case "boss_phase": log(`BOSS PHASE ${e.phase}: ${e.name} (${e.layer})`, "#ff2d7a"); break;
    case "chat": log(`[${e.channel}] ${e.from}: ${e.text}`); break;
    default: break;
  }
}

createGame({
  container: document.getElementById("game") as HTMLElement,
  serverUrl: gameServerUrl,
  getTicket,
  initialMapId: params.get("map") ?? "map_aurora_prime",
  graphics: (params.get("gfx") as GraphicsTier | "AUTO" | null) ?? "AUTO",
  isMobile: matchMedia("(pointer: coarse)").matches,
  onEvent,
  onHud: renderHud,
}).then((handle) => {
  statusEl.textContent = "";
  (window as unknown as { game: typeof handle }).game = handle;
}).catch((err: unknown) => {
  statusEl.textContent = err instanceof Error ? err.message : String(err);
});
