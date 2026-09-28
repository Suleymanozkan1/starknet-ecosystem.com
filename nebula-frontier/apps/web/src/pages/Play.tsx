import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { qk } from "../lib/queries.js";
import { EMPTY_HUD } from "../game/hudModel.js";
import type { HudEvent, HudView } from "../game/hudModel.js";
import { startGame } from "../game/adapter.js";
import type { GameActions } from "../game/adapter.js";
import { BossBar, DeathScreen, KillFeed, MapStrip, QuestTracker, ShipStatus, SkillBar, SquadFrames, StationPanel, TargetPanel, useKillFeed } from "../game/Hud.js";
import { MobileControls } from "../game/MobileControls.js";
import { LoadingScreen } from "../components/LoadingScreen.js";
import { MapTransition } from "../components/MapTransition.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { useSession, useFactionAccent } from "../hooks/useSession.js";
import { useIsMobileUI } from "../hooks/useMediaQuery.js";
import { useGraphicsTier } from "../hooks/useGraphicsTier.js";
import { onAppActiveChange } from "../native/lifecycle.js";
import { haptic } from "../native/haptics.js";
import { useGameLink } from "../store/gameLink.js";
import { useSettings } from "../store/settings.js";
import { toast } from "../store/ui.js";

type Phase = { kind: "ticket" } | { kind: "loading"; progress: number; label: string } | { kind: "running" } | { kind: "error"; message: string };

/**
 * Full-screen game session. Flow: POST /api/game/ticket → createGame({ container, ticket, mapId, gameServerUrl, ... })
 * → HudState/GameUiEvent callbacks drive the React HUD. Rendering pauses when the app is backgrounded.
 */
export default function PlayPage() {
  const me = useSession();
  useFactionAccent(me.faction);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mobile = useIsMobileUI();
  const tier = useGraphicsTier();
  const settings = useSettings();
  const container = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<GameActions | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ticket" });
  const [hud, setHud] = useState<HudView>(EMPTY_HUD);
  const [warp, setWarp] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const killFeed = useKillFeed();
  const setSendChat = useGameLink((s) => s.setSendChat);

  const onEvent = useCallback((e: HudEvent) => {
    switch (e.type) {
      case "hit":
        if (e.incoming) haptic(e.crit ? "heavy" : "medium");
        else if (e.crit) haptic("light");
        break;
      case "killfeed":
        killFeed.push(e);
        break;
      case "levelup":
        haptic("success");
        toast.success(`Level ${e.level}!`, "New gear and sectors unlocked.");
        void qc.invalidateQueries({ queryKey: qk.me });
        break;
      case "loot":
        toast.info(`Loot: ${e.label}`, e.credits ? `+${e.credits.toLocaleString()} credits` : undefined);
        break;
      case "reward":
        toast.success("Reward", e.text);
        break;
      case "notice":
        if (e.level === "error") toast.error(e.text);
        else if (e.level === "warn") toast.warn(e.text);
        else toast.info(e.text);
        break;
      case "boss_phase":
        haptic("heavy");
        toast.warn(`Boss phase ${e.phase}`, e.name);
        break;
      case "jump":
        setWarp(e.phase === "start" ? e.mapId : null);
        break;
      case "chat":
        void qc.invalidateQueries({ queryKey: ["chat"] });
        break;
    }
  }, [killFeed, qc]);

  // Values read once at boot; later changes are applied live through the actions API.
  const boot = useRef({ mobile, settings, onEvent });
  boot.current = { mobile, settings, onEvent };

  // Boot: ticket → engine. Re-runs only on explicit retry or graphics-tier change.
  useEffect(() => {
    const el = container.current;
    if (!el) return undefined;
    let cancelled = false;
    let actions: GameActions | null = null;
    setPhase({ kind: "ticket" });
    (async () => {
      try {
        const ticket = await api.game.ticket();
        if (cancelled) return;
        setWarp(ticket.mapId);
        setPhase({ kind: "loading", progress: 0.05, label: "Loading sector" });
        actions = await startGame(el, {
          ticket,
          tier,
          touch: boot.current.mobile,
          audio: { master: boot.current.settings.muted ? 0 : boot.current.settings.masterVolume, music: boot.current.settings.musicVolume, sfx: boot.current.settings.sfxVolume },
          onHud: (h) => { if (!cancelled) setHud(h); },
          onEvent: (e) => { if (!cancelled) boot.current.onEvent(e); },
          onProgress: (p, label) => { if (!cancelled) setPhase({ kind: "loading", progress: p, label }); },
        });
        if (cancelled) {
          actions.dispose();
          return;
        }
        actionsRef.current = actions;
        setSendChat((channel, text) => actions?.sendChat(channel, text));
        setPhase({ kind: "running" });
        window.setTimeout(() => setWarp(null), 400);
      } catch (e) {
        if (!cancelled) setPhase({ kind: "error", message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      setSendChat(null);
      actions?.dispose();
      actionsRef.current = null;
    };
  }, [attempt, tier, setSendChat]);

  useEffect(() => { actionsRef.current?.setAudio({ master: settings.muted ? 0 : settings.masterVolume, music: settings.musicVolume, sfx: settings.sfxVolume }); }, [settings.muted, settings.masterVolume, settings.musicVolume, settings.sfxVolume]);
  useEffect(() => onAppActiveChange((active) => actionsRef.current?.setPaused(!active)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && !chatOpen && !(e.target instanceof HTMLInputElement)) setChatOpen(true);
      if (e.key === "Escape" && chatOpen) setChatOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  const actions = actionsRef.current;
  const exit = (): void => {
    void navigate("/home");
  };

  return (
    <div className="nf-game-root">
      <div ref={container} className="nf-game-canvas" />
      {phase.kind === "running" && actions && (
        <div className="nf-hud">
          <div className="absolute left-3 top-[calc(12px+var(--safe-top))] grid gap-2">
            <ShipStatus hud={hud} compact={mobile} />
            {mobile && <MapStrip hud={hud} />}
            {!mobile && <SquadFrames hud={hud} />}
          </div>
          <div className="absolute left-1/2 grid -translate-x-1/2 justify-items-center gap-2" style={{ top: mobile ? 170 : 12 }}>
            {!mobile && <MapStrip hud={hud} />}
            <BossBar hud={hud} />
          </div>
          {/* The radar/minimap is drawn by the game client's Phaser overlay in the top-right corner
              (≤210px wide desktop, ≤130px touch). Shell controls sit to its left; panels flow below it. */}
          <div className="absolute top-[calc(12px+var(--safe-top))] flex gap-2" style={{ right: mobile ? 164 : 250 }}>
            <button type="button" className="nf-iconbtn" aria-label="Chat" onClick={() => setChatOpen((o) => !o)}><Icon name="chat" size={18} /></button>
            <button type="button" className="nf-iconbtn" aria-label="Leave to command deck" onClick={exit}><Icon name="logout" size={18} /></button>
          </div>
          <div className="absolute right-3 grid justify-items-end gap-2" style={{ top: mobile ? 150 : 214 }}>
            <TargetPanel hud={hud} onClear={() => actions.target("CLEAR")} />
            {!mobile && <QuestTracker hud={hud} />}
            <KillFeed feed={killFeed.feed} />
          </div>
          {!mobile && (
            <div className="absolute bottom-[calc(14px+var(--safe-bottom))] left-1/2 grid -translate-x-1/2 justify-items-center gap-2">
              {hud.dockPrompt && <NeonButton variant="primary" onClick={() => actions.dock()} icon={<span className="nf-kbd">F</span>}>Dock at {hud.dockPrompt.name}</NeonButton>}
              <SkillBar hud={hud} actions={actions} />
            </div>
          )}
          {mobile && (
            <>
              {hud.dockPrompt && <div className="absolute left-1/2 top-[calc(110px+var(--safe-top))] -translate-x-1/2"><NeonButton size="sm" variant="primary" onClick={() => actions.dock()}>Dock</NeonButton></div>}
              {!hud.dead && !hud.docked && <MobileControls hud={hud} actions={actions} />}
            </>
          )}
          <StationPanel hud={hud} actions={actions} />
          <DeathScreen hud={hud} actions={actions} />
          {chatOpen && (
            <div className="absolute bottom-[calc(96px+var(--safe-bottom))] left-3 h-[min(380px,50vh)] w-[min(360px,calc(100vw-24px))]">
              <ChatPanel me={me} embedded />
            </div>
          )}
        </div>
      )}
      {phase.kind === "ticket" && <LoadingScreen label="Requesting launch clearance" />}
      {phase.kind === "loading" && (warp ? <MapTransition mapId={warp} mode="launch" progress={phase.progress} /> : <LoadingScreen label={phase.label} progress={phase.progress} />)}
      {phase.kind === "running" && warp && <MapTransition mapId={warp} mode="warp" />}
      {phase.kind === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-[#03050a] p-6">
          <div className="nf-panel grid max-w-md gap-3 p-6 text-center">
            <div className="text-[12px] font-bold uppercase tracking-[0.3em] text-bad">Launch aborted</div>
            <p className="m-0 text-[14px] text-dim">{phase.message}</p>
            <div className="flex justify-center gap-2">
              <NeonButton variant="ghost" onClick={exit}>Command deck</NeonButton>
              <NeonButton variant="primary" onClick={() => setAttempt((a) => a + 1)}>Retry</NeonButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
