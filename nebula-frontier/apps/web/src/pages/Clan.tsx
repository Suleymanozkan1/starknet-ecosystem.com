import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { CurrencyAmount, Countdown, FactionEmblem, HoloPanel, Icon, Modal, NeonButton, StatBar, STAT_COLORS, Tabs } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { ClanDetailDto } from "../lib/dto.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useClans, useMyClan } from "../lib/queries.js";
import { useQuery } from "@tanstack/react-query";
import { faction, humanize, mapName, relTime } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { useSession } from "../hooks/useSession.js";

const ROLE_ORDER = ["LEADER", "OFFICER", "VETERAN", "MEMBER", "RECRUIT"];

function CreateClan() {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [description, setDescription] = useState("");
  const create = useApiMutation(() => api.clans.create({ name: name.trim(), tag, description }), { invalidate: [qk.me, qk.myClan, ["clans"]], success: `Clan [${tag}] founded` });
  const valid = /^[A-Za-z0-9 _-]{3,24}$/.test(name.trim()) && /^[A-Z0-9]{2,5}$/.test(tag);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) create.mutate(undefined);
  };
  return (
    <HoloPanel title="Found a clan" corners>
      <form className="grid gap-3" onSubmit={submit}>
        <label className="grid gap-1.5"><span className="nf-label">Clan name</span><input className="nf-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Void Lancers" /></label>
        <label className="grid gap-1.5"><span className="nf-label">Tag (2–5)</span><input className="nf-input uppercase" value={tag} maxLength={5} onChange={(e) => setTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="VOID" /></label>
        <label className="grid gap-1.5"><span className="nf-label">Charter</span><textarea className="nf-input min-h-[80px] py-2" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></label>
        <NeonButton type="submit" variant="primary" loading={create.isPending} disabled={!valid}>Found clan</NeonButton>
      </form>
    </HoloPanel>
  );
}

function ClanBrowser({ canJoin }: { canJoin: boolean }) {
  const [search, setSearch] = useState("");
  const clans = useClans(search);
  const join = useApiMutation((id: string) => api.clans.join(id), { invalidate: [qk.me, qk.myClan], success: "Application sent" });
  return (
    <HoloPanel title="Clan registry" actions={<input className="nf-input h-8 min-h-0 w-44 text-[13px]" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clans" />}>
      <QueryState q={clans} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No clans found" icon="clan" />}>
        {(list) => (
          <table className="nf-table">
            <thead><tr><th>Clan</th><th>Faction</th><th>Members</th><th>Score</th><th /></tr></thead>
            <tbody>
              {list.map((c) => {
                const f = faction(c.factionId);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/clan/${c.id}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">[{c.tag}] {c.name}</Link><div className="text-[11px] text-mute">Level {c.level}</div></td>
                    <td>{f ? <FactionEmblem path={f.emblem} color={f.color} size={20} framed={false} title={f.name} /> : "—"}</td>
                    <td className="tabular-nums">{c.memberCount}</td>
                    <td className="tabular-nums">{Number(c.score).toLocaleString()}</td>
                    <td className="text-right">{canJoin && <NeonButton size="sm" loading={join.isPending && join.variables === c.id} onClick={() => join.mutate(c.id)}>Join</NeonButton>}</td>
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
  const me = useSession();
  const [tab, setTab] = useState<"members" | "treasury" | "war" | "station">("members");
  const [amount, setAmount] = useState("");
  const [warTarget, setWarTarget] = useState<string>("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const f = faction(clan.factionId);
  const myRole = clan.myRole ?? clan.members.find((m) => m.userId === me.id)?.role ?? null;
  const officer = myRole === "LEADER" || myRole === "OFFICER";
  const inv = [qk.myClan, ["clans"], qk.me];
  const setRole = useApiMutation((v: { userId: string; role: string }) => api.clans.setRole(v.userId, v.role), { invalidate: inv, success: "Role updated" });
  const kick = useApiMutation((userId: string) => api.clans.kick(userId), { invalidate: inv, success: "Member removed" });
  const deposit = useApiMutation(() => api.clans.deposit(amount, idempotencyKey("clanbank")), { invalidate: inv, success: "Credits deposited", onSuccess: () => setAmount("") });
  const leave = useApiMutation(() => api.clans.leave(), { invalidate: inv, success: "You left the clan", onSuccess: () => setConfirmLeave(false) });
  const declare = useApiMutation(() => api.clans.declareWar(warTarget), { invalidate: inv, success: "War declared" });
  const clans = useClans("");
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
              <span>· Level {clan.level}</span><span>· {clan.memberCount} members</span><span>· Score {Number(clan.score).toLocaleString()}</span>
            </div>
            {clan.announcement && <p className="mb-0 mt-2 text-[13.5px] text-ink/90">{clan.announcement}</p>}
          </div>
          {mine && <NeonButton size="sm" variant="danger" onClick={() => setConfirmLeave(true)}>Leave</NeonButton>}
        </div>
      </HoloPanel>

      <Tabs value={tab} onChange={setTab} items={[{ key: "members", label: "Members", count: clan.members.length }, { key: "treasury", label: "Treasury" }, { key: "war", label: "Wars", count: clan.wars?.length ?? 0 }, { key: "station", label: "Station & territory" }]} />

      {tab === "members" && (
        <HoloPanel padded={false}>
          <div className="overflow-x-auto">
            <table className="nf-table">
              <thead><tr><th>Pilot</th><th>Role</th><th>Level</th><th>Contribution</th><th>Joined</th>{officer && mine && <th />}</tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td><Link to={`/profile/${m.userId}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">{m.online && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-good" />}{m.username}</Link></td>
                    <td>
                      {officer && mine && m.userId !== me.id && m.role !== "LEADER" ? (
                        <select className="nf-input h-8 min-h-0 w-auto py-0 text-[13px]" value={m.role} onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value })}>
                          {ROLE_ORDER.filter((r) => r !== "LEADER" && (myRole === "LEADER" || r !== "OFFICER")).map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                        </select>
                      ) : <span className="nf-chip">{humanize(m.role)}</span>}
                    </td>
                    <td className="tabular-nums">{m.level}</td>
                    <td><CurrencyAmount amount={m.contribution} currency="CREDITS" size={13} compact showSymbol={false} /></td>
                    <td className="text-dim">{relTime(m.joinedAt)}</td>
                    {officer && mine && <td className="text-right">{m.userId !== me.id && m.role !== "LEADER" && <button type="button" className="nf-ui text-[12px] uppercase tracking-[0.14em] text-bad" onClick={() => kick.mutate(m.userId)}>Remove</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </HoloPanel>
      )}

      {tab === "treasury" && (
        <div className="grid gap-4 md:grid-cols-2">
          <HoloPanel title="Clan bank">
            <div className="nf-label">Balance</div>
            <CurrencyAmount amount={clan.bankCredits} currency="CREDITS" size={28} />
            <p className="mb-0 mt-3 text-[13px] text-dim">The bank funds station upgrades, war declarations and territory defense. Withdrawals are officer-only and audited.</p>
          </HoloPanel>
          {mine && (
            <HoloPanel title="Contribute">
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(amount) && BigInt(amount) > 0n) deposit.mutate(undefined); }}>
                <label className="grid gap-1.5"><span className="nf-label">Credits</span><input className="nf-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="0" /></label>
                <div className="text-[12.5px] text-mute">Your balance: <CurrencyAmount amount={me.balances.credits} currency="CREDITS" size={12.5} /></div>
                <NeonButton type="submit" variant="primary" loading={deposit.isPending} disabled={!amount || BigInt(amount || "0") <= 0n || BigInt(amount || "0") > BigInt(me.balances.credits)}>Deposit</NeonButton>
              </form>
            </HoloPanel>
          )}
        </div>
      )}

      {tab === "war" && (
        <div className="grid gap-4">
          {officer && mine && (
            <HoloPanel title="Declare war">
              <div className="flex flex-wrap gap-2">
                <select className="nf-input flex-1" value={warTarget} onChange={(e) => setWarTarget(e.target.value)}>
                  <option value="">Select a rival clan…</option>
                  {(clans.data ?? []).filter((c) => c.id !== clan.id).map((c) => <option key={c.id} value={c.id}>[{c.tag}] {c.name}</option>)}
                </select>
                <NeonButton variant="danger" loading={declare.isPending} disabled={!warTarget} onClick={() => declare.mutate(undefined)}>Declare</NeonButton>
              </div>
            </HoloPanel>
          )}
          {(clan.wars ?? []).length === 0 ? <EmptyState title="No wars on record" icon="sword" /> : (clan.wars ?? []).map((w) => (
            <HoloPanel key={w.id}>
              <div className="flex flex-wrap items-center gap-4">
                <div className="nf-display text-[18px] font-bold">[{clan.tag}] <span className="text-accent">{w.scoreUs}</span> : <span className="text-bad">{w.scoreThem}</span> [{w.opponent.tag}]</div>
                <span className="nf-chip">{humanize(w.phase)}</span>
                <span className="text-[13px] text-dim">{mapName(w.mapId)}</span>
                <div className="flex-1" />
                {new Date(w.endsAt).getTime() > Date.now() ? <Countdown to={new Date(w.startsAt).getTime() > Date.now() ? w.startsAt : w.endsAt} prefix={new Date(w.startsAt).getTime() > Date.now() ? "Starts " : "Ends "} /> : <span className="text-[13px] text-mute">{w.winnerId ? (w.winnerId === clan.id ? "Victory" : "Defeat") : "Draw"}</span>}
              </div>
            </HoloPanel>
          ))}
        </div>
      )}

      {tab === "station" && (
        <div className="grid gap-4 md:grid-cols-2">
          {(clan.stations ?? []).length === 0 ? <EmptyState title="No clan station" body="Clan leaders can build a station in a controlled sector." icon="station" /> : (clan.stations ?? []).map((s) => (
            <HoloPanel key={s.id} title={`${mapName(s.mapId)} station · L${s.level}`}>
              <div className="grid gap-3">
                <StatBar label="Shield" value={s.shield} max={s.maxShield} color={STAT_COLORS.shield} />
                <StatBar label="Hull" value={s.hull} max={s.maxHull} color={STAT_COLORS.hull} />
                {s.underAttackAt && <div className="nf-chip" style={{ color: "var(--nf-bad)" }}><Icon name="warning" size={12} />Under attack {relTime(s.underAttackAt)}</div>}
                <div className="flex flex-wrap gap-1.5">{s.modules.map((mo) => <span key={mo.kind} className="nf-chip">{humanize(mo.kind)} L{mo.level}</span>)}</div>
              </div>
            </HoloPanel>
          ))}
          <HoloPanel title="Territory">
            {(clan.territories ?? []).length === 0 ? <div className="text-[13px] text-mute">No sectors held.</div> : (
              <ul className="m-0 grid list-none gap-1.5 p-0">{(clan.territories ?? []).map((t) => <li key={t.mapId} className="flex justify-between text-[14px]"><span>{mapName(t.mapId)}</span><span className="text-mute">{relTime(t.capturedAt)}</span></li>)}</ul>
            )}
          </HoloPanel>
        </div>
      )}

      <Modal open={confirmLeave} onClose={() => setConfirmLeave(false)} title="Leave clan?" footer={<><NeonButton variant="ghost" onClick={() => setConfirmLeave(false)}>Stay</NeonButton><NeonButton variant="danger" loading={leave.isPending} onClick={() => leave.mutate(undefined)}>Leave clan</NeonButton></>}>
        <p className="m-0 text-dim">Your contribution history stays with the clan. {myRole === "LEADER" ? "As leader you must transfer leadership first if other members remain." : ""}</p>
      </Modal>
    </div>
  );
}

export default function ClanPage() {
  const me = useSession();
  const { clanId } = useParams();
  const mine = useMyClan(!clanId && Boolean(me.clan));
  const other = useQuery({ queryKey: ["clans", "detail", clanId], queryFn: () => api.clans.get(clanId!), enabled: Boolean(clanId) });

  if (clanId) {
    return (
      <div>
        <PageHeader eyebrow="Clan dossier" title="Clan" actions={<Link to="/clan" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">Back</Link>} />
        {other.error ? <ErrorState error={other.error} onRetry={() => void other.refetch()} /> : other.data ? <ClanView clan={other.data} mine={other.data.id === me.clan?.id} /> : <div className="nf-skeleton h-64" />}
      </div>
    );
  }
  if (me.clan) {
    return (
      <div>
        <PageHeader eyebrow="Your clan" title={`[${me.clan.tag}] ${me.clan.name}`} />
        {mine.error ? <ErrorState error={mine.error} onRetry={() => void mine.refetch()} /> : mine.data ? <ClanView clan={mine.data} mine /> : <div className="nf-skeleton h-64" />}
      </div>
    );
  }
  return (
    <div>
      <PageHeader eyebrow="Brotherhood" title="Clans" subtitle="Band together for clan wars, stations, shared treasury and territory." />
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <CreateClan />
        <ClanBrowser canJoin />
      </div>
    </div>
  );
}
