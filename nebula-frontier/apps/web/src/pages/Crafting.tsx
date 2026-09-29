import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { BLUEPRINTS_BY_ID, ITEMS_BY_ID } from "@nebula/config";
import { Countdown, CurrencyAmount, HoloPanel, Icon, NeonButton, RarityBadge, Tabs, rarityStyle } from "@nebula/game-ui";
import type { BlueprintDef, ResourceId } from "@nebula/shared";
import { api } from "../lib/api.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useCrafting, useInventory } from "../lib/queries.js";
import { formatDuration } from "@nebula/game-ui";
import { itemName, RESOURCE_META, resourceLabel } from "../lib/gameMeta.js";
import { Rich, enumLabel, tNow, useT } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { useSession } from "../hooks/useSession.js";
import { haptic } from "../native/haptics.js";
import { toast } from "../store/ui.js";

function Blueprint({ bp, have }: { bp: BlueprintDef; have: { credits: bigint; resources: Partial<Record<string, number>>; items: Map<string, number>; level: number } }) {
  const t = useT();
  const out = ITEMS_BY_ID.get(bp.outputItem);
  const start = useApiMutation(() => api.crafting.start(bp.id, idempotencyKey("craft")), { invalidate: [qk.blueprints, qk.me, qk.inventory], success: t("crafting.started", { name: bp.name }), onSuccess: () => haptic("medium") });
  const missing: string[] = [];
  if (have.level < bp.requiredLevel) missing.push(t("common.levelN", { n: bp.requiredLevel }));
  if (BigInt(bp.credits) > have.credits) missing.push(t("common.credits"));
  for (const [k, v] of Object.entries(bp.resources)) if ((have.resources[k] ?? 0) < (v ?? 0)) missing.push(resourceLabel(k));
  for (const i of bp.items ?? []) if ((have.items.get(i.itemId) ?? 0) < i.quantity) missing.push(itemName(i.itemId));
  return (
    <article className="nf-panel nf-rarity-frame grid content-start gap-3 p-4" style={rarityStyle(out?.rarity ?? "COMMON")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="nf-label">{t("crafting.blueprintTier", { tier: enumLabel(bp.tier) })}</div>
          <div className="nf-ui text-[16px] font-bold">{bp.name}</div>
        </div>
        {out && <RarityBadge rarity={out.rarity} />}
      </div>
      <div className="text-[13px] text-dim"><Rich text={t("crafting.produces")} parts={{ item: <b className="text-ink">{bp.outputQuantity > 1 ? `${bp.outputQuantity}× ` : ""}{out?.name ?? bp.outputItem}</b> }} /></div>
      <div className="grid gap-1.5 rounded-lg border border-line bg-black/25 p-3 text-[13px]">
        {bp.credits > 0 && <div className="flex justify-between"><span className="text-dim">{t("common.credits")}</span><CurrencyAmount amount={bp.credits} currency="CREDITS" size={13} showSymbol={false} /></div>}
        {Object.entries(bp.resources).map(([k, v]) => {
          const ok = (have.resources[k] ?? 0) >= (v ?? 0);
          return <div key={k} className="flex justify-between"><span style={{ color: RESOURCE_META[k as ResourceId]?.color }}>{resourceLabel(k)}</span><span className={ok ? "tabular-nums" : "tabular-nums text-bad"}>{have.resources[k] ?? 0}/{v}</span></div>;
        })}
        {(bp.items ?? []).map((i) => {
          const n = have.items.get(i.itemId) ?? 0;
          return <div key={i.itemId} className="flex justify-between"><span className="text-dim">{itemName(i.itemId)}</span><span className={n >= i.quantity ? "tabular-nums" : "tabular-nums text-bad"}>{n}/{i.quantity}</span></div>;
        })}
      </div>
      <div className="flex items-center justify-between text-[12px] text-mute">
        <span className="flex items-center gap-1"><Icon name="clock" size={13} />{formatDuration(bp.craftTimeSec * 1000, { showSeconds: false })}</span>
        <span>{t("common.success", { pct: Math.round(bp.successChance * 100) })}</span>
      </div>
      <NeonButton size="sm" variant="primary" block loading={start.isPending} disabled={missing.length > 0} onClick={() => start.mutate(undefined)} title={missing.length ? t("crafting.missingList", { list: missing.join(", ") }) : undefined}>
        {missing.length ? t("crafting.missing", { first: missing[0] ?? "", more: missing.length > 1 ? ` +${missing.length - 1}` : "" }) : t("crafting.fabricate")}
      </NeonButton>
    </article>
  );
}

export default function CraftingPage() {
  const t = useT();
  const me = useSession();
  const q = useCrafting();
  const inv = useInventory();
  const [tier, setTier] = useState("ALL");
  const claim = useApiMutation((id: string) => api.crafting.claim(id), {
    invalidate: [qk.blueprints, qk.inventory],
    onSuccess: (r) => {
      haptic(r.success ? "success" : "warning");
      if (r.success) toast.success(tNow("crafting.complete"), tNow("crafting.addedToCargo", { qty: r.quantity, item: itemName(r.outputItem) }));
      else toast.warn(tNow("crafting.failed"), tNow("crafting.failedBody"));
    },
  });
  const have = useMemo(() => {
    const items = new Map<string, number>();
    for (const i of inv.data?.items ?? []) items.set(i.itemId, (items.get(i.itemId) ?? 0) + i.quantity);
    return { credits: BigInt(me.balances.credits), resources: me.balances.resources, items, level: me.level };
  }, [inv.data, me]);
  const tiers = [...new Set((q.data?.blueprints ?? []).map((b) => b.tier))];
  const list = (q.data?.blueprints ?? []).filter((b) => tier === "ALL" || b.tier === tier).sort((a, b) => a.requiredLevel - b.requiredLevel);

  return (
    <div>
      <PageHeader eyebrow={t("crafting.eyebrow")} title={t("nav.crafting")} subtitle={t("crafting.subtitle")} />
      <QueryState q={q}>
        {(d) => (
          <div className="grid gap-5">
            <HoloPanel title={t("crafting.queue", { n: d.jobs.length })}>
              {d.jobs.length === 0 ? <div className="text-[13px] text-mute">{t("crafting.noJobs")}</div> : (
                <div className="grid gap-2">
                  {d.jobs.map((j) => {
                    const bp = BLUEPRINTS_BY_ID.get(j.blueprintId);
                    const ready = j.ready || new Date(j.completesAt).getTime() <= Date.now();
                    return (
                      <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-black/20 px-3 py-2">
                        <Icon name="crafting" size={18} />
                        <span className="nf-ui flex-1 text-[15px] font-bold">{bp?.name ?? j.blueprintId}</span>
                        {ready ? <NeonButton size="sm" variant="success" loading={claim.isPending} onClick={() => claim.mutate(j.id)}>{t("crafting.collect")}</NeonButton> : <Countdown to={j.completesAt} className="text-[14px]" />}
                      </div>
                    );
                  })}
                </div>
              )}
            </HoloPanel>
            <Tabs value={tier} onChange={setTier} items={[{ key: "ALL", label: t("common.all") }, ...tiers.map((x) => ({ key: x, label: enumLabel(x) }))]} />
            {list.length === 0 ? <EmptyState title={t("crafting.noBlueprints")} icon="crafting" /> : (
              <div className="nf-grid-cards" style={{ "--card-min": "260px" } as CSSProperties}>
                {list.map((bp) => <Blueprint key={bp.id} bp={bp} have={have} />)}
              </div>
            )}
          </div>
        )}
      </QueryState>
    </div>
  );
}
