import { useState } from "react";
import type { CSSProperties } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MAPS_BY_ID, SHIPS_BY_ID, FACTIONS } from "@nebula/config";
import { FactionEmblem, Icon, Modal, NeonButton } from "@nebula/game-ui";
import { api } from "../../lib/api.js";
import type { FactionDto } from "../../lib/dto.js";
import { useT } from "../../lib/i18n.js";
import { qk, useApiMutation, useFactions, useMe } from "../../lib/queries.js";
import { humanize } from "../../lib/gameMeta.js";
import { haptic } from "../../native/haptics.js";
import { OnboardingSteps } from "./OnboardingSteps.js";

function bonusLabel(k: string, v: number): string {
  return `+${v}% ${humanize(k.replace(/([A-Z])/g, "_$1"))}`;
}

export default function FactionSelectPage() {
  const t = useT();
  const me = useMe();
  const factions = useFactions();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const choose = useApiMutation((factionId: string) => api.me.setFaction(factionId), {
    errorTitle: "Could not join faction",
    onSuccess: (user) => {
      qc.setQueryData(qk.me, user);
      void qc.invalidateQueries({ queryKey: qk.ships });
      haptic("success");
      navigate("/onboarding/ship", { replace: true });
    },
  });

  if (me.data?.faction) return <Navigate to="/onboarding/ship" replace />;

  // Live data (member counts) from the API, falling back to the static lore while it loads.
  const list: FactionDto[] = factions.data?.length ? factions.data : FACTIONS.map((f) => ({ ...f, bonus: f.bonus as Record<string, number> }));
  const sel = list.find((f) => f.id === selected) ?? null;

  return (
    <div className="relative z-10 min-h-screen px-4 pb-[calc(120px+var(--safe-bottom))] pt-[calc(24px+var(--safe-top))] md:px-10" style={sel ? ({ "--nf-accent": sel.color } as CSSProperties) : undefined}>
      <OnboardingSteps step={1} />
      <header className="mx-auto mb-8 mt-6 grid max-w-3xl justify-items-center gap-2 text-center">
        <div className="nf-eyebrow">Allegiance</div>
        <h1 className="nf-h1 text-[clamp(26px,4vw,44px)]">{t("onboard.faction")}</h1>
        <p className="m-0 text-[14.5px] text-dim">Your faction sets your home sector, starter ship and faction bonuses. This choice is permanent for this pilot.</p>
      </header>

      <div className="mx-auto grid max-w-[1320px] gap-5 lg:grid-cols-3" role="radiogroup" aria-label="Factions">
        {list.map((f) => {
          const active = f.id === selected;
          const ship = SHIPS_BY_ID.get(f.starterShip);
          const home = MAPS_BY_ID.get(f.homeMap);
          return (
            <article
              key={f.id}
              role="radio"
              aria-checked={active}
              tabIndex={0}
              data-testid={`faction-${f.id}`}
              onClick={() => { haptic("selection"); setSelected(f.id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(f.id); } }}
              className="nf-panel nf-panel--interactive nf-panel--cut relative flex flex-col overflow-hidden outline-none"
              style={{
                "--nf-accent": f.color,
                borderColor: active ? f.color : undefined,
                boxShadow: active ? `0 0 0 1px ${f.color}, 0 0 60px -12px ${f.color}` : undefined,
                opacity: selected && !active ? 0.62 : 1,
              } as CSSProperties}
            >
              <div className="relative grid h-[210px] place-items-center overflow-hidden" style={{ background: `radial-gradient(circle at 50% 60%, color-mix(in oklab, ${f.color} 35%, transparent), transparent 62%), linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.5))` }}>
                <div className="absolute inset-0 opacity-30" style={{ backgroundImage: `repeating-linear-gradient(90deg, transparent 0 38px, color-mix(in oklab, ${f.color} 40%, transparent) 38px 39px)`, maskImage: "radial-gradient(circle, black, transparent 70%)" }} />
                <FactionEmblem path={f.emblem} color={f.color} secondaryColor={f.secondaryColor} size={150} />
                {active && <span className="nf-chip absolute right-3 top-3" style={{ color: f.color, borderColor: f.color }}><Icon name="check" size={12} /> Selected</span>}
              </div>
              <div className="grid flex-1 content-start gap-3 p-5">
                <div>
                  <div className="nf-display text-[20px] font-bold tracking-[0.12em]" style={{ color: f.color }}>{f.name}</div>
                  <div className="text-[13.5px] italic text-dim">“{f.motto}”</div>
                </div>
                <p className="m-0 text-[13.5px] leading-relaxed text-dim">{f.lore}</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(f.bonus).map(([k, v]) => (
                    <span key={k} className="nf-chip" style={{ color: f.color, borderColor: `color-mix(in oklab, ${f.color} 50%, transparent)` }}>{bonusLabel(k, v)}</span>
                  ))}
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-[13px]">
                  <div><dt className="nf-label">Starter ship</dt><dd className="m-0 nf-ui text-[15px] font-bold">{ship?.name ?? f.starterShip} <span className="text-mute">· {humanize(ship?.class ?? "")}</span></dd></div>
                  <div><dt className="nf-label">Home</dt><dd className="m-0 nf-ui text-[15px] font-bold">{home?.name ?? f.homeMap}</dd></div>
                  {f.members !== undefined && <div><dt className="nf-label">Pilots</dt><dd className="m-0 nf-ui text-[15px] font-bold tabular-nums">{f.members.toLocaleString()}</dd></div>}
                  <div><dt className="nf-label">Tag</dt><dd className="m-0 nf-ui text-[15px] font-bold">[{f.tag}]</dd></div>
                </dl>
              </div>
            </article>
          );
        })}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-[rgba(4,7,14,0.88)] px-4 pb-[calc(14px+var(--safe-bottom))] pt-3.5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3">
          <div className="nf-ui min-w-0 truncate text-[14px] uppercase tracking-[0.18em] text-dim">
            {sel ? <>Pledge to <b style={{ color: sel.color }}>{sel.name}</b></> : "Select a faction"}
          </div>
          <NeonButton variant="primary" size="lg" disabled={!sel} onClick={() => setConfirm(true)} icon={<Icon name="arrowRight" size={18} />} data-testid="faction-confirm">
            {t("common.confirm")}
          </NeonButton>
        </div>
      </div>

      <Modal
        open={confirm && Boolean(sel)}
        onClose={() => setConfirm(false)}
        locked={choose.isPending}
        title="Confirm allegiance"
        footer={
          <>
            <NeonButton variant="ghost" onClick={() => setConfirm(false)} disabled={choose.isPending}>{t("common.cancel")}</NeonButton>
            <NeonButton variant="primary" loading={choose.isPending} onClick={() => sel && choose.mutate(sel.id)} data-testid="faction-pledge">Pledge allegiance</NeonButton>
          </>
        }
      >
        {sel && (
          <div className="flex items-center gap-4">
            <FactionEmblem path={sel.emblem} color={sel.color} secondaryColor={sel.secondaryColor} size={72} />
            <p className="m-0 text-[14px] text-dim">
              You are about to join <b style={{ color: sel.color }}>{sel.name}</b>. You will receive the <b className="text-ink">{SHIPS_BY_ID.get(sel.starterShip)?.name}</b> and its
              starter loadout, and deploy from <b className="text-ink">{MAPS_BY_ID.get(sel.homeMap)?.name}</b>. Faction choice cannot be changed later.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
