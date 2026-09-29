import { useState } from "react";
import { HoloPanel, Icon, NeonButton, StatBar, STAT_COLORS, Tabs } from "@nebula/game-ui";
import type { QuestDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import { qk, useApiMutation, useQuests } from "../lib/queries.js";
import { objectiveLabel } from "../lib/gameMeta.js";
import { contentText, enumLabel, useT } from "../lib/i18n.js";
import type { RewardBundleView } from "../lib/dto.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { haptic } from "../native/haptics.js";

function QuestCard({ q, mode }: { q: QuestDto; mode: "active" | "available" }) {
  const t = useT();
  const accept = useApiMutation(() => api.quests.accept(q.questId), { invalidate: [qk.quests], success: t("missions.accepted", { name: q.name }), onSuccess: () => haptic("light") });
  const claim = useApiMutation(() => api.quests.claim(q.id), { invalidate: [qk.quests, qk.me, qk.inventory], success: t("missions.rewardsClaimed", { name: q.name }), onSuccess: () => haptic("success") });
  const total = q.objectives.reduce((a, o) => a + o.count, 0);
  const done = q.objectives.reduce((a, o) => a + Math.min(o.count, o.progress), 0);
  return (
    <HoloPanel glow={q.status === "COMPLETED"}>
      <div className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="nf-label">{enumLabel(q.type)}</div>
            <div className="nf-ui text-[18px] font-bold">{q.name}</div>
          </div>
          {q.status === "COMPLETED" && <span className="nf-chip" style={{ color: "var(--nf-good)", borderColor: "var(--nf-good)" }}><Icon name="check" size={11} />{t("missions.complete")}</span>}
          {q.status === "CLAIMED" && <span className="nf-chip">{t("common.claimed")}</span>}
        </div>
        <p className="m-0 text-[13.5px] text-dim">{contentText("quest", q.questId, q.description)}</p>
        <ul className="m-0 grid list-none gap-2 p-0">
          {q.objectives.map((o, i) => (
            <li key={i}>
              <StatBar
                label={objectiveLabel(o.type, o.target)}
                value={mode === "active" ? Math.min(o.count, o.progress) : 0}
                max={o.count}
                height={5}
                ghost={false}
                color={o.progress >= o.count ? STAT_COLORS.hull : "var(--nf-accent)"}
                format={(v, m) => `${v}/${m}`}
              />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <RewardChips bundle={q.rewards as RewardBundleView} />
          {mode === "available" && <NeonButton size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate(undefined)}>{t("common.accept")}</NeonButton>}
          {mode === "active" && q.status === "COMPLETED" && <NeonButton size="sm" variant="success" loading={claim.isPending} onClick={() => claim.mutate(undefined)}>{t("missions.claimRewards")}</NeonButton>}
          {mode === "active" && q.status === "ACTIVE" && <span className="nf-label">{t("common.pct", { n: Math.round((done / Math.max(1, total)) * 100) })}</span>}
        </div>
      </div>
    </HoloPanel>
  );
}

export default function MissionsPage() {
  const t = useT();
  const q = useQuests();
  const [tab, setTab] = useState<"active" | "available" | "done">("active");
  const active = (q.data?.active ?? []).filter((x) => x.status !== "CLAIMED");
  const done = (q.data?.active ?? []).filter((x) => x.status === "CLAIMED");
  const available = q.data?.available ?? [];
  const list = tab === "active" ? active : tab === "available" ? available : done;
  return (
    <div>
      <PageHeader eyebrow={t("missions.eyebrow")} title={t("nav.missions")} subtitle={t("missions.subtitle")} />
      <Tabs className="mb-4" value={tab} onChange={setTab} items={[{ key: "active", label: t("missions.active"), count: active.length }, { key: "available", label: t("missions.available"), count: available.length }, { key: "done", label: t("missions.completed"), count: done.length }]} />
      <QueryState q={q}>
        {() => list.length === 0 ? (
          <EmptyState icon="missions" title={tab === "available" ? t("missions.noContracts") : t("missions.none")} body={tab === "active" ? t("missions.acceptHint") : undefined} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((x) => <QuestCard key={x.id || x.questId} q={x} mode={tab === "available" ? "available" : "active"} />)}
          </div>
        )}
      </QueryState>
    </div>
  );
}
