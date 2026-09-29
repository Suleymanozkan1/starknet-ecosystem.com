import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { CurrencyAmount, Countdown, FactionEmblem, HoloPanel, Icon, Modal, NeonButton, StatBar, STAT_COLORS, Tabs } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { ClanDetailDto } from "../lib/dto.js";
import type { ClanRole } from "@nebula/shared";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useClan, useClanWars, useClans } from "../lib/queries.js";
import { faction, mapName, relTime } from "../lib/gameMeta.js";
import { En, Rich, enumLabel, fmtNum, useT } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { useSession } from "../hooks/useSession.js";

const ROLE_ORDER = ["LEADER", "OFFICER", "VETERAN", "MEMBER", "RECRUIT"];

function CreateClan() {
  const t = useT();
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [description, setDescription] = useState("");
  const create = useApiMutation(() => api.clans.create({ name: name.trim(), tag, description }), { invalidate: [qk.me, ["clans"]], success: t("clan.founded", { tag }) });
  const valid = /^[A-Za-z0-9 _-]{3,24}$/.test(name.trim()) && /^[A-Z0-9]{2,5}$/.test(tag);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) create.mutate(undefined);
  };
  return (
    <HoloPanel title={t("clan.found")} corners>
      <form className="grid gap-3" onSubmit={submit}>
        <label className="grid gap-1.5"><span className="nf-label">{t("clan.name")}</span><input className="nf-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Void Lancers" /></label>
        <label className="grid gap-1.5"><span className="nf-label">{t("clan.tag")}</span><input className="nf-input uppercase" value={tag} maxLength={5} onChange={(e) => setTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="VOID" /></label>
        <label className="grid gap-1.5"><span className="nf-label">{t("clan.charter")}</span><textarea className="nf-input min-h-[80px] py-2" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></label>
        <NeonButton type="submit" variant="primary" loading={create.isPending} disabled={!valid}>{t("clan.foundBtn")}</NeonButton>
      </form>
    </HoloPanel>
  );
}

function ClanBrowser({ canJoin }: { canJoin: boolean }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const clans = useClans(search);
  const join = useApiMutation((id: string) => api.clans.join(id), { invalidate: [qk.me, ["clans"]], success: t("clan.welcome"), errorTitle: t("clan.cannotJoin") });
  return (
    <HoloPanel title={t("clan.registry")} actions={<input className="nf-input h-8 min-h-0 w-44 text-[13px]" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("clan.searchAria")} />}>
      <QueryState q={clans} isEmpty={(d) => d.length === 0} empty={<EmptyState title={t("clan.noneFound")} icon="clan" />}>
        {(list) => (
          <table className="nf-table">
            <thead><tr><th>{t("lb.clan")}</th><th>{t("common.faction")}</th><th>{t("common.members")}</th><th>{t("common.score")}</th><th /></tr></thead>
            <tbody>
              {list.map((c) => {
                const f = faction(c.factionId);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/clan/${c.id}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">[{c.tag}] {c.name}</Link><div className="text-[11px] text-mute">{t("common.levelN", { n: c.level })}</div></td>
                    <td>{f ? <FactionEmblem path={f.emblem} color={f.color} size={20} framed={false} title={f.name} /> : "—"}</td>
                    <td className="tabular-nums">{c.members}</td>
                    <td className="tabular-nums">{fmtNum(Number(c.score))}</td>
                    <td className="text-right">{canJoin && <NeonButton size="sm" loading={join.isPending && join.variables === c.id} onClick={() => join.mutate(c.id)} title={t("clan.inviteRequired")}>{t("clan.acceptInvite")}</NeonButton>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </QueryState>
    </HoloPanel>
  );
}

function ClanView({ clan, mine }: { clan: ClanDetailDto; mine: boolean }) {
  const t = useT();
  const me = useSession();
  const [tab, setTab] = useState<"members" | "treasury" | "war" | "station">("members");
  const [amount, setAmount] = useState("");
  const [warTarget, setWarTarget] = useState<string>("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const f = faction(clan.factionId);
  const myRole: ClanRole | null = mine ? (me.clan?.role ?? null) : null;
  const officer = myRole === "LEADER" || myRole === "OFFICER";
  const inv = [["clans"], qk.me];
  const setRole = useApiMutation((v: { userId: string; role: string }) => api.clans.promote(clan.id, v.userId, v.role), { invalidate: inv, success: t("clan.roleUpdated") });
  const kick = useApiMutation((userId: string) => api.clans.kick(clan.id, userId), { invalidate: inv, success: t("clan.memberRemoved") });
  const deposit = useApiMutation(() => api.clans.deposit(clan.id, amount, idempotencyKey("clanbank")), { invalidate: inv, success: t("clan.deposited"), onSuccess: () => setAmount("") });
  const leave = useApiMutation(() => api.clans.leave(), { invalidate: inv, success: t("clan.left"), onSuccess: () => setConfirmLeave(false) });
  const declare = useApiMutation(() => api.clans.declareWar(clan.id, warTarget), { invalidate: inv, success: t("clan.warDeclared") });
  const acceptWar = useApiMutation((warId: string) => api.clans.acceptWar(warId), { invalidate: inv, success: t("clan.warAccepted") });
  const clans = useClans("");
  const wars = useClanWars(clan.id);
  const clanName = (id: string): string => {
    const c = (clans.data ?? []).find((x) => x.id === id);
    return c ? `[${c.tag}] ${c.name}` : id === clan.id ? `[${clan.tag}] ${clan.name}` : t("clan.unknown");
  };
  const members = [...clan.members].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  return (
    <div className="grid gap-5">
      <HoloPanel glow corners accent={f?.color}>
        <div className="flex flex-wrap items-center gap-5">
          <div className="grid h-20 w-20 place-items-center rounded-2xl border border-line bg-black/30">
            <span className="nf-display text-[22px] font-black text-accent">{clan.tag}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="nf-display text-[26px] font-bold tracking-[0.06em]">{clan.name}</div>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-dim">
              {f && <span className="flex items-center gap-1"><FactionEmblem path={f.emblem} color={f.color} size={16} framed={false} />{f.name}</span>}
              <span>· {t("common.levelN", { n: clan.level })}</span><span>· {t("clan.membersN", { n: clan.members.length })}</span><span>· {t("clan.scoreN", { n: fmtNum(Number(clan.score)) })}</span>
            </div>
            {clan.announcement && <p className="mb-0 mt-2 text-[13.5px] text-ink/90">{clan.announcement}</p>}
          </div>
          {mine && <NeonButton size="sm" variant="danger" onClick={() => setConfirmLeave(true)}>{t("common.leave")}</NeonButton>}
        </div>
      </HoloPanel>

      <Tabs value={tab} onChange={setTab} items={[{ key: "members", label: t("clan.members"), count: clan.members.length }, { key: "treasury", label: t("clan.treasury") }, { key: "war", label: t("clan.wars"), count: wars.data?.length ?? 0 }, { key: "station", label: t("clan.station") }]} />
      {clan.description && tab === "members" && <p className="m-0 text-[13.5px] text-dim">{clan.description}</p>}

      {tab === "members" && (
        <HoloPanel padded={false}>
          <div className="overflow-x-auto">
            <table className="nf-table">
              <thead><tr><th>{t("clan.pilot")}</th><th>{t("clan.role")}</th><th>{t("common.level")}</th><th>{t("clan.contribution")}</th><th>{t("clan.joined")}</th>{officer && mine && <th />}</tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td><Link to={`/profile/${m.userId}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">{m.username}</Link></td>
                    <td>
                      {officer && mine && m.userId !== me.id && m.role !== "LEADER" ? (
                        <select className="nf-input h-8 min-h-0 w-auto py-0 text-[13px]" value={m.role} onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value })}>
                          {ROLE_ORDER.filter((r) => r !== "LEADER" && (myRole === "LEADER" || r !== "OFFICER")).map((r) => <option key={r} value={r}>{enumLabel(r)}</option>)}
                        </select>
                      ) : <span className="nf-chip">{enumLabel(m.role)}</span>}
                    </td>
                    <td className="tabular-nums">{m.level}</td>
                    <td><CurrencyAmount amount={m.contribution} currency="CREDITS" size={13} compact showSymbol={false} /></td>
                    <td className="text-dim">{relTime(m.joinedAt)}</td>
                    {officer && mine && <td className="text-right">{m.userId !== me.id && m.role !== "LEADER" && <button type="button" className="nf-ui text-[12px] uppercase tracking-[0.14em] text-bad" onClick={() => kick.mutate(m.userId)}>{t("common.remove")}</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </HoloPanel>
      )}

      {tab === "treasury" && (
        <div className="grid gap-4 md:grid-cols-2">
          <HoloPanel title={t("clan.bank")}>
            <div className="nf-label">{t("clan.balance")}</div>
            {clan.treasury !== null ? <CurrencyAmount amount={clan.treasury} currency="CREDITS" size={28} /> : <div className="text-[13px] text-mute">{t("clan.membersOnly")}</div>}
            <p className="mb-0 mt-3 text-[13px] text-dim">{t("clan.bankInfo")}</p>
          </HoloPanel>
          {mine && (
            <HoloPanel title={t("clan.contribute")}>
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(amount) && BigInt(amount) > 0n) deposit.mutate(undefined); }}>
                <label className="grid gap-1.5"><span className="nf-label">{t("common.credits")}</span><input className="nf-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="0" /></label>
                <div className="text-[12.5px] text-mute"><Rich text={t("clan.yourBalance")} parts={{ amount: <CurrencyAmount amount={me.balances.credits} currency="CREDITS" size={12.5} /> }} /></div>
                <NeonButton type="submit" variant="primary" loading={deposit.isPending} disabled={!amount || BigInt(amount || "0") <= 0n || BigInt(amount || "0") > BigInt(me.balances.credits)}>{t("wallet.deposit")}</NeonButton>
              </form>
            </HoloPanel>
          )}
        </div>
      )}

      {tab === "war" && (
        <div className="grid gap-4">
          {officer && mine && (
            <HoloPanel title={t("clan.declareWar")}>
              <div className="flex flex-wrap gap-2">
                <select className="nf-input flex-1" value={warTarget} onChange={(e) => setWarTarget(e.target.value)}>
                  <option value="">{t("clan.selectRival")}</option>
                  {(clans.data ?? []).filter((c) => c.id !== clan.id).map((c) => <option key={c.id} value={c.id}>[{c.tag}] {c.name}</option>)}
                </select>
                <NeonButton variant="danger" loading={declare.isPending} disabled={!warTarget} onClick={() => declare.mutate(undefined)}>{t("clan.declare")}</NeonButton>
              </div>
            </HoloPanel>
          )}
          {wars.isLoading ? <div className="nf-skeleton h-20" /> : (wars.data ?? []).length === 0 ? <EmptyState title={t("clan.noWars")} icon="sword" /> : (wars.data ?? []).map((w) => {
            const weAreA = w.clanAId === clan.id;
            const us = weAreA ? w.scoreA : w.scoreB;
            const them = weAreA ? w.scoreB : w.scoreA;
            const opp = weAreA ? w.clanBId : w.clanAId;
            const pending = w.phase === "DECLARED" || w.phase === "PREPARATION";
            return (
              <HoloPanel key={w.id}>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="nf-display text-[18px] font-bold">[{clan.tag}] <span className="text-accent">{us}</span> : <span className="text-bad">{them}</span> <span className="text-dim">{clanName(opp)}</span></div>
                  <span className="nf-chip">{enumLabel(w.phase)}</span>
                  <span className="text-[13px] text-dim">{mapName(w.mapId)}</span>
                  <div className="flex-1" />
                  {pending && !weAreA && officer && mine && <NeonButton size="sm" variant="danger" loading={acceptWar.isPending} onClick={() => acceptWar.mutate(w.id)}>{t("clan.acceptWar")}</NeonButton>}
                  {new Date(w.endsAt).getTime() > Date.now() ? <Countdown to={new Date(w.startsAt).getTime() > Date.now() ? w.startsAt : w.endsAt} prefix={new Date(w.startsAt).getTime() > Date.now() ? t("clan.startsPrefix") : t("clan.endsPrefix")} /> : <span className="text-[13px] text-mute">{w.winnerId ? (w.winnerId === clan.id ? t("clan.victory") : t("clan.defeat")) : t("clan.draw")}</span>}
                </div>
              </HoloPanel>
            );
          })}
        </div>
      )}

      {tab === "station" && (
        <div className="grid gap-4 md:grid-cols-2">
          {clan.stations.length === 0 ? <EmptyState title={t("clan.noStation")} body={t("clan.noStationBody")} icon="station" /> : clan.stations.map((s) => (
            <HoloPanel key={s.id} title={t("clan.stationTitle", { map: mapName(s.mapId), level: s.level })}>
              <div className="grid gap-3">
                <StatBar label={t("stat.shield")} value={s.shield} max={s.maxShield} color={STAT_COLORS.shield} />
                <StatBar label={t("stat.hull")} value={s.hull} max={s.maxHull} color={STAT_COLORS.hull} />
                <div className="flex flex-wrap gap-1.5">{s.modules.map((mo) => <span key={mo.kind} className="nf-chip">{t("clan.moduleLevel", { name: enumLabel(mo.kind), level: mo.level })}</span>)}</div>
              </div>
            </HoloPanel>
          ))}
          <HoloPanel title={t("clan.territory")}>
            {clan.territories.length === 0 ? <div className="text-[13px] text-mute">{t("clan.noSectors")}</div> : (
              <ul className="m-0 grid list-none gap-1.5 p-0">{clan.territories.map((t) => <li key={t} className="flex items-center gap-2 text-[14px]"><Icon name="map" size={14} />{mapName(t)}</li>)}</ul>
            )}
          </HoloPanel>
        </div>
      )}

      <Modal open={confirmLeave} onClose={() => setConfirmLeave(false)} title={t("clan.leaveTitle")} footer={<><NeonButton variant="ghost" onClick={() => setConfirmLeave(false)}>{t("clan.stay")}</NeonButton><NeonButton variant="danger" loading={leave.isPending} onClick={() => leave.mutate(undefined)}>{t("clan.leaveClan")}</NeonButton></>}>
        <p className="m-0 text-dim">{t("clan.leaveBody")} {myRole === "LEADER" ? t("clan.leaderNote") : ""}</p>
      </Modal>
    </div>
  );
}

export default function ClanPage() {
  const t = useT();
  const me = useSession();
  const { clanId } = useParams();
  const id = clanId ?? me.clan?.id ?? null;
  const clan = useClan(id);

  if (id) {
    const mine = id === me.clan?.id;
    return (
      <div>
        <PageHeader eyebrow={mine ? t("clan.yours") : t("clan.dossier")} title={clan.data ? <En>{`[${clan.data.tag}] ${clan.data.name}`}</En> : t("nav.clan")} actions={clanId ? <Link to="/clan" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">{t("common.back")}</Link> : undefined} />
        {clan.error ? <ErrorState error={clan.error} onRetry={() => void clan.refetch()} /> : clan.data ? <ClanView clan={clan.data} mine={mine} /> : <div className="nf-skeleton h-64" />}
        {!mine && !me.clan && <div className="mt-5"><ClanBrowser canJoin /></div>}
      </div>
    );
  }
  return (
    <div>
      <PageHeader eyebrow={t("clan.eyebrow")} title={t("clan.title")} subtitle={t("clan.subtitle")} />
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <CreateClan />
        <ClanBrowser canJoin />
      </div>
    </div>
  );
}
