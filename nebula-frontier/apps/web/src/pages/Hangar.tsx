import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router-dom";
import { ITEMS_BY_ID, SHIPS_BY_ID } from "@nebula/config";
import {
  CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, RarityBadge, Tabs, rarityColor, rarityStyle,
} from "@nebula/game-ui";
import type { InventoryItemDto, LoadoutDto, ShipInstanceDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useInventory, useShips } from "../lib/queries.js";
import { humanize, RESOURCE_META } from "../lib/gameMeta.js";
import { COSMETIC_SLOTS, SLOT_TYPES, cosmeticShipOf, cosmeticSlotOf, slotArray, slotFamilyOf } from "../lib/slots.js";
import type { SlotType } from "../lib/slots.js";
import { PageHeader } from "../components/PageHeader.js";
import { ErrorState, EmptyState } from "../components/QueryState.js";
import { ShipViewer } from "../components/ShipViewer.js";
import type { PreviewMode } from "../components/ShipViewer.js";
import { ShipStatBars } from "../components/ShipStatBars.js";
import { DND_MIME, ItemIcon, ItemTile } from "../components/ItemTile.js";
import { useIsMobileUI } from "../hooks/useMediaQuery.js";
import { haptic } from "../native/haptics.js";
import { toast } from "../store/ui.js";
import type { ResourceId } from "@nebula/shared";

const PRESETS: LoadoutDto["preset"][] = ["PVP", "PVE", "TANK", "SPEED", "MINING", "BOSS", "RAID", "CUSTOM"];
const FORMATIONS = ["STANDARD", "ARROW", "TURTLE", "DIAMOND", "WHEEL"] as const;
const PREVIEWS: { key: PreviewMode; label: string }[] = [
  { key: "idle", label: "Idle" },
  { key: "engine", label: "Engines" },
  { key: "fire", label: "Weapons" },
  { key: "shield", label: "Shield" },
  { key: "damage", label: "Damage" },
];

type Picker = { slotType: SlotType; slotIndex: number } | null;

function SlotTile({ item, label, onClick, onDrop, index }: { item: InventoryItemDto | undefined; label: string; index: number; onClick: () => void; onDrop: (inventoryItemId: string) => void }) {
  const [over, setOver] = useState(false);
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DND_MIME)) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const id = e.dataTransfer.getData(DND_MIME);
      if (id) onDrop(id);
    },
  };
  return (
    <button
      type="button"
      className="nf-slot"
      data-filled={Boolean(item)}
      data-drop={over}
      style={item ? rarityStyle(item.rarity) : undefined}
      onClick={onClick}
      aria-label={item ? `${label} ${index + 1}: ${item.name}` : `Empty ${label} slot ${index + 1}`}
      {...handlers}
    >
      {item ? (
        <span className="grid justify-items-center gap-1">
          <ItemIcon item={item} size={24} />
          <span className="nf-ui line-clamp-2 text-[11px] font-bold leading-tight">{item.name}</span>
          {item.upgradeLevel > 0 && <span className="absolute right-1 top-0.5 nf-display text-[10px] text-accent">+{item.upgradeLevel}</span>}
        </span>
      ) : (
        <Icon name="plus" size={18} />
      )}
    </button>
  );
}

function UpgradePanel({ ship }: { ship: ShipInstanceDto }) {
  const [open, setOpen] = useState(false);
  const [cost, setCost] = useState<Awaited<ReturnType<typeof api.ships.upgradeCost>> | null>(null);
  const [loadingCost, setLoadingCost] = useState(false);
  const upgrade = useApiMutation(() => api.ships.upgrade(ship.id, idempotencyKey("shipup")), {
    invalidate: [qk.ships, qk.me],
    errorTitle: "Upgrade failed",
    onSuccess: (r) => {
      haptic(r.success ? "success" : "warning");
      if (r.success) toast.success(`Upgrade successful`, `${ship.name} is now +${r.toLevel}`);
      else toast.warn("Upgrade failed", "Materials were consumed. Your ship keeps its current level.");
      setOpen(false);
    },
  });
  const openModal = async (): Promise<void> => {
    setOpen(true);
    setLoadingCost(true);
    try {
      setCost(await api.ships.upgradeCost(ship.id));
    } catch {
      setCost(null);
    } finally {
      setLoadingCost(false);
    }
  };
  return (
    <>
      <NeonButton size="sm" onClick={() => void openModal()} icon={<Icon name="arrowRight" size={14} style={{ transform: "rotate(-90deg)" }} />}>Upgrade +{ship.upgradeLevel + 1}</NeonButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        locked={upgrade.isPending}
        title={`Upgrade ${ship.name}`}
        footer={
          <>
            <NeonButton variant="ghost" onClick={() => setOpen(false)} disabled={upgrade.isPending}>Cancel</NeonButton>
            <NeonButton variant="primary" loading={upgrade.isPending} disabled={!cost?.cost || cost.maxed} onClick={() => upgrade.mutate(undefined)}>Attempt upgrade</NeonButton>
          </>
        }
      >
        {loadingCost && <div className="nf-skeleton h-28" />}
        {!loadingCost && cost?.maxed && <p className="m-0 text-dim">This ship is at maximum upgrade level.</p>}
        {!loadingCost && cost?.cost && (
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <span className="nf-display text-[28px] font-bold">+{ship.upgradeLevel} <span className="text-mute">→</span> <span className="text-accent">+{cost.cost.toLevel}</span></span>
              <span className="nf-chip" style={{ color: cost.cost.successChance > 0.6 ? "var(--nf-good)" : "var(--nf-warn)" }}>{Math.round(cost.cost.successChance * 100)}% success</span>
            </div>
            <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
              <div className="nf-label">Cost</div>
              {BigInt(cost.cost.credits) > 0n && <CurrencyAmount amount={cost.cost.credits} currency="CREDITS" />}
              {BigInt(cost.cost.gems) > 0n && <CurrencyAmount amount={cost.cost.gems} currency="GEMS" />}
              {Object.entries(cost.cost.resources).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-[14px]"><span style={{ color: RESOURCE_META[k as ResourceId]?.color }}>{RESOURCE_META[k as ResourceId]?.label ?? k}</span><span className="tabular-nums">×{v}</span></div>
              ))}
            </div>
            <p className="m-0 text-[12.5px] text-mute">Costs are consumed whether or not the upgrade succeeds. A failed attempt never lowers the current level.</p>
          </div>
        )}
        {!loadingCost && !cost && <p className="m-0 text-bad">Could not load the upgrade cost.</p>}
      </Modal>
    </>
  );
}

export default function HangarPage() {
  const ships = useShips();
  const inv = useInventory();
  const mobile = useIsMobileUI();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadoutId, setLoadoutId] = useState<string | null>(null);
  const [tab, setTab] = useState<"loadout" | "customize" | "compare">("loadout");
  const [preview, setPreview] = useState<PreviewMode>("idle");
  const [autoRotate, setAutoRotate] = useState(true);
  const [picker, setPicker] = useState<Picker>(null);
  const [compareId, setCompareId] = useState<string>("");
  const [newLoadout, setNewLoadout] = useState<{ name: string; preset: LoadoutDto["preset"] } | null>(null);

  const owned = ships.data?.owned ?? [];
  const ship = owned.find((s) => s.id === selectedId) ?? owned.find((s) => s.active) ?? owned[0];
  const def = ship ? SHIPS_BY_ID.get(ship.defId) : undefined;
  const loadout = ship?.loadouts.find((l) => l.id === (loadoutId ?? ship.activeLoadoutId)) ?? ship?.loadouts[0];
  const items = inv.data?.items ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const invalidate = [qk.ships, qk.inventory, qk.me];
  const equip = useApiMutation((v: { slotType: SlotType; slotIndex: number; inventoryItemId: string }) =>
    api.inventory.equip({ shipInstanceId: ship!.id, loadoutId: loadout!.id, ...v }), { invalidate, errorTitle: "Cannot equip", onSuccess: () => { haptic("medium"); setPicker(null); } });
  const unequip = useApiMutation((v: { slotType: SlotType; slotIndex: number }) =>
    api.inventory.unequip({ shipInstanceId: ship!.id, loadoutId: loadout!.id, ...v }), { invalidate, errorTitle: "Cannot unequip", onSuccess: () => { haptic("light"); setPicker(null); } });
  const activateShip = useApiMutation((id: string) => api.ships.activate(id), { invalidate, success: "Ship activated" });
  const activateLoadout = useApiMutation((id: string) => api.ships.activateLoadout(ship!.id, id), { invalidate, success: "Loadout active" });
  const createLoadout = useApiMutation((v: { name: string; preset: LoadoutDto["preset"] }) =>
    api.ships.createLoadout(ship!.id, { ...v, ...(loadout ? { copyFromLoadoutId: loadout.id } : {}) }), { invalidate: [qk.ships], success: "Loadout created", onSuccess: (lo) => { setLoadoutId(lo.id); setNewLoadout(null); } });
  const setFormation = useApiMutation((formation: string) => api.ships.updateLoadout(ship!.id, loadout!.id, { formation }), { invalidate: [qk.ships] });
  const setCosmetic = useApiMutation((v: { slot: string; inventoryItemId: string | null }) => api.ships.setCosmetic(ship!.id, v.slot, v.inventoryItemId), { invalidate: [qk.ships], success: "Cosmetic applied" });

  if (ships.error) return <ErrorState error={ships.error} onRetry={() => void ships.refetch()} />;
  if (ships.isLoading) return <div className="grid gap-4"><div className="nf-skeleton h-10 w-60" /><div className="nf-skeleton h-[520px]" /></div>;
  if (!ship || !def) return <EmptyState title="Your hangar is empty" body="Choose a faction to receive your starter ship." icon="hangar" />;

  const compareDef = compareId ? SHIPS_BY_ID.get(compareId) : undefined;
  const statsNow: Record<string, number> = { ...def.stats, ...ship.stats };
  const pickerItems = picker ? items.filter((i) => slotFamilyOf(i) === picker.slotType) : [];
  const pickerCurrent = picker && loadout ? slotArray(loadout, picker.slotType, def.slots[SLOT_TYPES.find((s) => s.key === picker.slotType)!.shipSlot])[picker.slotIndex] : null;
  const cosmeticsOwned = items.filter((i) => (i.category === "SKIN" || i.category === "COSMETIC") && cosmeticSlotOf(i.itemId) && (!cosmeticShipOf(i.itemId) || cosmeticShipOf(i.itemId) === ship.defId));
  const equippables = items.filter((i) => slotFamilyOf(i) && !i.equippedOn);

  const onDropItem = (slotType: SlotType, slotIndex: number, inventoryItemId: string): void => {
    const it = byId.get(inventoryItemId);
    if (!it) return;
    if (slotFamilyOf(it) !== slotType) {
      toast.warn("Incompatible slot", `${it.name} cannot be fitted into ${slotType}.`);
      haptic("warning");
      return;
    }
    equip.mutate({ slotType, slotIndex, inventoryItemId });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Hangar bay"
        title={`${ship.name}${ship.upgradeLevel ? ` +${ship.upgradeLevel}` : ""}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><RarityBadge rarity={def.rarity} /><span className="nf-chip">{humanize(def.class)}</span><span className="nf-chip">Tier {def.tier}</span><span className="nf-chip">GS {Math.round(ship.gearScore)}</span>{ship.active && <span className="nf-chip" style={{ color: "var(--nf-good)", borderColor: "var(--nf-good)" }}>Active</span>}</span>}
        actions={
          <>
            {!ship.active && <NeonButton variant="primary" size="sm" loading={activateShip.isPending} onClick={() => activateShip.mutate(ship.id)}>Set active</NeonButton>}
            <UpgradePanel ship={ship} />
            <Link to="/ships" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">Ship catalog</Link>
          </>
        }
      />

      {owned.length > 1 && (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {owned.map((s) => {
            const d = SHIPS_BY_ID.get(s.defId);
            return (
              <button key={s.id} type="button" onClick={() => { setSelectedId(s.id); setLoadoutId(null); }} className="nf-panel nf-panel--interactive flex shrink-0 items-center gap-2 px-3 py-2" style={{ borderColor: s.id === ship.id ? "var(--nf-accent)" : undefined, ...(d ? rarityStyle(d.rarity) : {}) }}>
                <Icon name="ship" size={16} style={{ color: d ? rarityColor(d.rarity) : undefined }} />
                <span className="nf-ui text-[14px] font-bold">{s.name}{s.upgradeLevel ? ` +${s.upgradeLevel}` : ""}</span>
                {s.active && <span className="h-2 w-2 rounded-full bg-good" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <div className="grid content-start gap-4">
          <HoloPanel padded={false} corners glow className="relative h-[clamp(320px,52vh,600px)]">
            <ShipViewer def={def} cosmetics={ship.cosmetics} preview={preview} autoRotate={autoRotate} compare={compareDef ?? null} />
            <div className="absolute left-3 right-3 top-3 flex flex-wrap gap-1.5">
              {PREVIEWS.map((p) => (
                <button key={p.key} type="button" className="nf-chip cursor-pointer" style={p.key === preview ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined} onClick={() => setPreview(p.key)}>{p.label}</button>
              ))}
            </div>
            <button type="button" className="nf-chip absolute bottom-3 right-3 cursor-pointer" onClick={() => setAutoRotate((a) => !a)} aria-pressed={autoRotate}>
              <Icon name="refresh" size={12} /> {autoRotate ? "Auto-rotate on" : "Auto-rotate off"}
            </button>
            <div className="nf-ui pointer-events-none absolute bottom-4 left-4 hidden text-[11px] uppercase tracking-[0.2em] text-mute sm:block">Drag to rotate · Scroll / pinch to zoom</div>
          </HoloPanel>
          <HoloPanel title="Performance">
            <ShipStatBars stats={statsNow} compare={compareDef ? (compareDef.stats as unknown as Record<string, number>) : null} />
          </HoloPanel>
        </div>

        <div className="grid content-start gap-4">
          <Tabs value={tab} onChange={setTab} items={[{ key: "loadout", label: "Loadout" }, { key: "customize", label: "Customize" }, { key: "compare", label: "Compare" }]} />

          {tab === "loadout" && loadout && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {ship.loadouts.map((l) => (
                  <button key={l.id} type="button" className="nf-chip cursor-pointer" onClick={() => setLoadoutId(l.id)} style={l.id === loadout.id ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined}>
                    {l.id === ship.activeLoadoutId && <span className="h-1.5 w-1.5 rounded-full bg-good" />}{l.name.toUpperCase() === l.preset ? l.name : `${l.name} · ${humanize(l.preset)}`}
                  </button>
                ))}
                <button type="button" className="nf-chip cursor-pointer" onClick={() => setNewLoadout({ name: "", preset: "PVP" })}><Icon name="plus" size={12} /> New</button>
                {loadout.id !== ship.activeLoadoutId && (
                  <NeonButton size="sm" loading={activateLoadout.isPending} onClick={() => activateLoadout.mutate(loadout.id)}>Use this loadout</NeonButton>
                )}
              </div>

              <HoloPanel>
                <div className="grid gap-4">
                  {SLOT_TYPES.map((st) => {
                    const count = def.slots[st.shipSlot];
                    if (!count) return null;
                    const arr = slotArray(loadout, st.key, count);
                    return (
                      <div key={st.key} className="grid gap-2">
                        <div className="nf-label flex items-center gap-2"><Icon name={st.icon} size={13} />{st.label} <span className="text-mute">({arr.filter(Boolean).length}/{count})</span></div>
                        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${mobile ? 4 : 5}, minmax(0, 1fr))` }}>
                          {arr.map((id, i) => (
                            <SlotTile key={i} index={i} label={st.label} item={id ? byId.get(id) : undefined} onClick={() => setPicker({ slotType: st.key, slotIndex: i })} onDrop={(itemId) => onDropItem(st.key, i, itemId)} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {def.slots.drone > 0 && (
                    <label className="grid gap-1.5">
                      <span className="nf-label">Drone formation</span>
                      <select className="nf-input" value={loadout.formation || "STANDARD"} onChange={(e) => setFormation.mutate(e.target.value)} disabled={setFormation.isPending}>
                        {FORMATIONS.map((f) => <option key={f} value={f}>{humanize(f)}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              </HoloPanel>

              {!mobile && (
                <HoloPanel title="Cargo hold" actions={<span className="nf-label">Drag onto a slot</span>}>
                  {inv.isLoading ? <div className="nf-skeleton h-24" /> : equippables.length === 0 ? (
                    <div className="text-[13px] text-mute">No unequipped gear. Buy or craft weapons, generators, modules and drones.</div>
                  ) : (
                    <div className="grid max-h-[260px] grid-cols-4 gap-2 overflow-y-auto pr-1">
                      {equippables.map((i) => <ItemTile key={i.id} item={i} compact draggable onClick={() => { const f = slotFamilyOf(i); if (f) setPicker({ slotType: f, slotIndex: Math.max(0, slotArray(loadout, f, def.slots[SLOT_TYPES.find((s) => s.key === f)!.shipSlot]).indexOf(null)) }); }} />)}
                    </div>
                  )}
                </HoloPanel>
              )}
            </>
          )}

          {tab === "customize" && (
            <HoloPanel title="Cosmetics">
              <div className="grid gap-3">
                {COSMETIC_SLOTS.map((slot) => {
                  const current = ship.cosmetics[slot];
                  const options = cosmeticsOwned.filter((i) => cosmeticSlotOf(i.itemId) === slot);
                  return (
                    <label key={slot} className="grid gap-1.5">
                      <span className="nf-label">{humanize(slot)}</span>
                      <select
                        className="nf-input"
                        value={options.find((o) => o.itemId === current)?.id ?? ""}
                        disabled={setCosmetic.isPending || (options.length === 0 && !current)}
                        onChange={(e) => setCosmetic.mutate({ slot, inventoryItemId: e.target.value || null })}
                      >
                        <option value="">{current ? `Remove (${ITEMS_BY_ID.get(current)?.name ?? current})` : options.length ? "Default" : "No owned cosmetics"}</option>
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </label>
                  );
                })}
                <Link to="/shop?cat=SKINS" className="nf-link text-[13px]">Browse skins in the shop →</Link>
              </div>
            </HoloPanel>
          )}

          {tab === "compare" && (
            <HoloPanel title="Compare with">
              <select className="nf-input" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                <option value="">Select a ship…</option>
                {(ships.data?.catalog ?? []).filter((c) => c.id !== ship.defId).map((c) => <option key={c.id} value={c.id}>{c.name} · T{c.tier} {humanize(c.class)}</option>)}
              </select>
              {compareDef && (
                <div className="mt-4 grid gap-3">
                  <div className="nf-ui text-[13px] text-dim">Bars show <b className="text-ink">{ship.name}</b>; values in brackets are the difference vs <b className="text-ink">{compareDef.name}</b>.</div>
                  <div className="grid grid-cols-2 gap-2 text-[13px]">
                    {(["laser", "missile", "generator", "module", "drone"] as const).map((k) => (
                      <div key={k} className="flex justify-between rounded border border-line px-2 py-1"><span className="text-dim">{humanize(k)} slots</span><span className="tabular-nums">{def.slots[k]} <span className="text-mute">vs</span> {compareDef.slots[k]}</span></div>
                    ))}
                  </div>
                </div>
              )}
            </HoloPanel>
          )}
        </div>
      </div>

      <Modal open={Boolean(picker)} onClose={() => setPicker(null)} wide title={picker ? `Fit ${SLOT_TYPES.find((s) => s.key === picker.slotType)?.label} · slot ${picker.slotIndex + 1}` : ""}
        footer={pickerCurrent ? <NeonButton variant="danger" loading={unequip.isPending} onClick={() => picker && unequip.mutate({ slotType: picker.slotType, slotIndex: picker.slotIndex })}>Unequip</NeonButton> : undefined}
      >
        {pickerItems.length === 0 ? (
          <EmptyState title="No compatible items" body="Buy, craft or loot gear for this slot." action={<Link to="/shop" className="nf-link" onClick={() => setPicker(null)}>Open shop</Link>} icon="inventory" />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {pickerItems.map((i) => (
              <ItemTile key={i.id} item={i} selected={i.id === pickerCurrent} onClick={() => picker && i.id !== pickerCurrent && equip.mutate({ slotType: picker.slotType, slotIndex: picker.slotIndex, inventoryItemId: i.id })} />
            ))}
          </div>
        )}
        {equip.isPending && <div className="nf-ui mt-3 text-[12px] uppercase tracking-[0.2em] text-accent">Fitting…</div>}
      </Modal>

      <Modal open={Boolean(newLoadout)} onClose={() => setNewLoadout(null)} title="New loadout"
        footer={<NeonButton variant="primary" loading={createLoadout.isPending} disabled={!newLoadout?.name.trim()} onClick={() => newLoadout && createLoadout.mutate({ name: newLoadout.name.trim(), preset: newLoadout.preset })}>Create</NeonButton>}
      >
        {newLoadout && (
          <div className="grid gap-3">
            <label className="grid gap-1.5"><span className="nf-label">Name</span><input className="nf-input" maxLength={24} value={newLoadout.name} onChange={(e) => setNewLoadout({ ...newLoadout, name: e.target.value })} placeholder="e.g. Boss hunter" /></label>
            <div className="grid gap-1.5">
              <span className="nf-label">Preset</span>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => <button key={p} type="button" className="nf-chip cursor-pointer" style={p === newLoadout.preset ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined} onClick={() => setNewLoadout({ ...newLoadout, preset: p })}>{humanize(p)}</button>)}
              </div>
            </div>
            <p className="m-0 text-[12.5px] text-mute">The current loadout is copied as a starting point.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
