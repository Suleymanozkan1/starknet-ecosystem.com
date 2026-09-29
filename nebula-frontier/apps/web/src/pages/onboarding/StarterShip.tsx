import { Navigate, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { SHIPS_BY_ID, WEAPONS_BY_ID, MODULES_BY_ID, DRONES_BY_ID, MAPS_BY_ID } from "@nebula/config";
import { FactionEmblem, HoloPanel, Icon, NeonButton, RarityBadge, StatBar } from "@nebula/game-ui";
import { api } from "../../lib/api.js";
import { contentText, enumLabel, enumText, useT } from "../../lib/i18n.js";
import { qk, useApiMutation, useMe, useShips } from "../../lib/queries.js";
import { faction } from "../../lib/gameMeta.js";
import { ShipViewer } from "../../components/ShipViewer.js";
import { ShipStatBars } from "../../components/ShipStatBars.js";
import { ErrorState } from "../../components/QueryState.js";
import { OnboardingSteps } from "./OnboardingSteps.js";
import { useFactionAccent } from "../../hooks/useSession.js";
import { haptic } from "../../native/haptics.js";

export default function StarterShipPage() {
  const t = useT();
  const me = useMe();
  const ships = useShips();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useFactionAccent(me.data?.faction);
  const f = faction(me.data?.faction);
  const owned = ships.data?.owned ?? [];
  const inst = owned.find((s) => s.id === me.data?.activeShipInstanceId) ?? owned[0];
  const def = inst ? SHIPS_BY_ID.get(inst.defId) : f ? SHIPS_BY_ID.get(f.starterShip) : undefined;

  const activate = useApiMutation((id: string) => api.ships.activate(id), {
    errorTitle: t("onboard.activateFailed"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
    },
  });

  if (!me.data) return null;
  if (!me.data.faction) return <Navigate to="/onboarding/faction" replace />;

  const confirm = async (to: string): Promise<void> => {
    haptic("success");
    if (inst && (!me.data?.activeShipInstanceId || me.data.activeShipInstanceId !== inst.id)) await activate.mutateAsync(inst.id);
    navigate(to);
  };

  const loadout = f?.starterLoadout;
  return (
    <div className="relative z-10 min-h-screen px-4 pb-[calc(40px+var(--safe-bottom))] pt-[calc(24px+var(--safe-top))] md:px-10">
      <OnboardingSteps step={2} />
      <header className="mx-auto mb-6 mt-6 grid max-w-3xl justify-items-center gap-2 text-center">
        <div className="nf-eyebrow flex items-center gap-2" lang="en">{f && <FactionEmblem path={f.emblem} color={f.color} size={18} framed={false} />}{f?.name}</div>
        <h1 className="nf-h1 text-[clamp(26px,4vw,44px)]">{t("onboard.ship")}</h1>
      </header>

      {ships.error ? (
        <div className="mx-auto max-w-xl"><ErrorState error={ships.error} onRetry={() => void ships.refetch()} /></div>
      ) : (
        <div className="mx-auto grid max-w-[1320px] gap-5 lg:grid-cols-[1.5fr_1fr]">
          <HoloPanel padded={false} corners glow className="relative min-h-[380px] lg:min-h-[560px]">
            {def ? <ShipViewer def={def} cosmetics={inst?.cosmetics ?? {}} className="absolute inset-0" /> : <div className="nf-skeleton absolute inset-4" />}
            <div className="pointer-events-none absolute left-5 top-4 grid gap-1">
              <div className="nf-display text-[clamp(26px,3vw,40px)] font-black tracking-[0.1em]">{def?.name ?? "—"}</div>
              {def && <div className="flex items-center gap-2"><RarityBadge rarity={def.rarity} /><span className="nf-chip">{enumLabel(def.class)}</span><span className="nf-chip">{t("common.tierN", { n: def.tier })}</span></div>}
            </div>
            <div className="nf-ui pointer-events-none absolute bottom-3 left-5 text-[11px] uppercase tracking-[0.2em] text-mute">{t("hangar.dragHint")}</div>
          </HoloPanel>

          <div className="grid content-start gap-4">
            <HoloPanel title={t("onboard.specs")}>
              {def ? <ShipStatBars stats={inst?.stats && Object.keys(inst.stats).length ? { ...def.stats, ...inst.stats } : def.stats} /> : <div className="nf-skeleton h-40" />}
              {def && <p className="mb-0 mt-3 text-[13.5px] leading-relaxed text-dim">{contentText("ship", def.id, def.description)}</p>}
            </HoloPanel>
            {def && (
              <HoloPanel title={t("onboard.abilities")}>
                <ul className="m-0 grid list-none gap-2.5 p-0">
                  {def.abilities.map((a) => (
                    <li key={a.id} className="flex gap-3">
                      <span className="mt-0.5 text-accent"><Icon name={a.kind === "ULTIMATE" ? "ultimate" : a.kind === "ACTIVE" ? "zap" : "shield"} size={18} /></span>
                      <div>
                        <div className="nf-ui text-[15px] font-bold">{a.name} <span className="text-[11px] tracking-[0.16em] text-mute">{enumText(a.kind, a.kind)}</span></div>
                        <div className="text-[13px] text-dim">{contentText("ability", a.id, a.description)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </HoloPanel>
            )}
            {loadout && (
              <HoloPanel title={t("onboard.loadout")}>
                <div className="flex flex-wrap gap-1.5">
                  {[...loadout.weapons.map((id) => WEAPONS_BY_ID.get(id)?.name ?? id), ...loadout.modules.map((id) => MODULES_BY_ID.get(id)?.name ?? id), ...loadout.drones.map((id) => DRONES_BY_ID.get(id)?.name ?? id)].map((n, i) => (
                    <span key={`${n}-${i}`} className="nf-chip" lang="en">{n}</span>
                  ))}
                </div>
              </HoloPanel>
            )}
            <div className="grid gap-2">
              <NeonButton variant="primary" size="lg" block loading={activate.isPending} disabled={!inst} onClick={() => void confirm("/play")} icon={<Icon name="rocket" size={18} />} data-testid="ship-confirm">
                {t("onboard.enter")}
              </NeonButton>
              <NeonButton variant="ghost" block disabled={!inst || activate.isPending} onClick={() => void confirm("/home")}>
                {t("onboard.commandDeck")}
              </NeonButton>
              {f && <div className="text-center text-[12px] text-mute">{t("onboard.deployingTo", { map: MAPS_BY_ID.get(f.homeMap)?.name ?? "" })}</div>}
            </div>
          </div>
        </div>
      )}
      {!ships.error && !ships.isLoading && owned.length === 0 && (
        <div className="mx-auto mt-4 max-w-xl"><StatBar value={0} max={1} label={t("onboard.provisioning")} showValue={false} /></div>
      )}
    </div>
  );
}
