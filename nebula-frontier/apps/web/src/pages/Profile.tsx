import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FactionEmblem, HoloPanel, Icon, NeonButton, StatBar, Tabs } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { qk, useAchievements, useApiMutation, useProfile } from "../lib/queries.js";
import { faction, relTime } from "../lib/gameMeta.js";
import { En, Rich, contentText, enumLabel, fmtNum, rankLabel, tNow, useT } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { LevelHex } from "../components/AppShell.js";
import { useLogout, useSession } from "../hooks/useSession.js";
import { share } from "../native/share.js";
import { toast } from "../store/ui.js";

function Achievements() {
  const t = useT();
  const q = useAchievements();
  const [cat, setCat] = useState("ALL");
  const claim = useApiMutation((id: string) => api.achievements.claim(id), { invalidate: [qk.achievements, qk.me, qk.inventory], success: t("profile.achievementClaimed") });
  const cats = [...new Set((q.data ?? []).map((a) => a.category))];
  return (
    <HoloPanel title={t("profile.achievements")}>
      <Tabs variant="pill" className="mb-3" value={cat} onChange={setCat} items={[{ key: "ALL", label: t("common.all") }, ...cats.map((c) => ({ key: c, label: enumLabel(c) }))]} />
      <QueryState q={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title={t("profile.noAchievements")} icon="trophy" />}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2">
            {list.filter((a) => cat === "ALL" || a.category === cat).map((a) => (
              <div key={a.id} className="grid gap-2 rounded-lg border border-line bg-black/20 p-3" style={a.unlocked ? { borderColor: "color-mix(in oklab, var(--nf-credits) 50%, transparent)" } : undefined}>
                <div className="flex items-start gap-2">
                  <span style={{ color: a.unlocked ? "var(--nf-credits)" : "var(--nf-text-mute)" }}><Icon name="trophy" size={20} /></span>
                  <div className="min-w-0 flex-1"><div className="nf-ui text-[15px] font-bold">{a.name}</div><div className="text-[12.5px] text-dim">{contentText("achievement", a.id, a.description)}</div></div>
                  {a.unlocked && !a.claimed && <NeonButton size="sm" variant="success" loading={claim.isPending && claim.variables === a.id} onClick={() => claim.mutate(a.id)}>{t("common.claim")}</NeonButton>}
                  {a.claimed && <span className="nf-chip text-[10px]" style={{ color: "var(--nf-good)" }}>{t("common.claimed")}</span>}
                </div>
                <StatBar value={a.progress} max={a.threshold} height={4} ghost={false} color={a.unlocked ? "var(--nf-credits)" : "var(--nf-accent)"} format={(v, m) => `${fmtNum(v)} / ${fmtNum(m)}`} />
                <RewardChips bundle={a.rewards} size={11.5} />
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </HoloPanel>
  );
}

function Security() {
  const t = useT();
  const logout = useLogout();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.auth.sessions });
  const logoutAll = useApiMutation(() => api.auth.logoutAll(), { onSuccess: () => void logout() });
  return (
    <HoloPanel title={t("profile.security")}>
      <QueryState q={sessions}>
        {(d) => (
          <div className="grid gap-2">
            {d.sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <Icon name="globe" size={14} />
                <span className="min-w-0 flex-1 truncate text-dim">{s.userAgent ?? t("profile.unknownDevice")}</span>
                {s.current && <span className="nf-chip text-[10px]" style={{ color: "var(--nf-good)" }}>{t("profile.thisDevice")}</span>}
                <span className="text-[11px] text-mute">{t("profile.active", { when: relTime(s.lastUsedAt) })}</span>
              </div>
            ))}
          </div>
        )}
      </QueryState>
      <div className="mt-3 flex flex-wrap gap-2">
        <NeonButton size="sm" variant="ghost" onClick={() => void logout()}>{t("profile.signOut")}</NeonButton>
        <NeonButton size="sm" variant="danger" loading={logoutAll.isPending} onClick={() => logoutAll.mutate(undefined)}>{t("profile.signOutAll")}</NeonButton>
      </div>
    </HoloPanel>
  );
}

function Rename() {
  const t = useT();
  const me = useSession();
  const [name, setName] = useState(me.username);
  const rename = useApiMutation(() => api.me.rename(name), { invalidate: [qk.me], success: t("profile.renamed") });
  const valid = /^[A-Za-z0-9_]{3,20}$/.test(name) && name !== me.username;
  return (
    <HoloPanel title={t("auth.username")}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) rename.mutate(undefined); }}>
        <input className="nf-input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} aria-label={t("auth.username")} />
        <NeonButton type="submit" loading={rename.isPending} disabled={!valid}>{t("profile.rename")}</NeonButton>
      </form>
      <div className="mt-2 text-[12px] text-mute">{t("profile.renameHint")}</div>
    </HoloPanel>
  );
}

export default function ProfilePage() {
  const { userId } = useParams();
  const t = useT();
  const me = useSession();
  const own = !userId || userId === me.id;
  const q = useProfile(own ? undefined : userId);
  const p = q.data;
  const f = faction(p?.faction);
  const onShare = async (): Promise<void> => {
    const base = import.meta.env.VITE_PUBLIC_WEB_URL || window.location.origin;
    const r = await share({ title: `${p?.username} · Nebula Frontier`, text: tNow("profile.shareText", { name: p?.username ?? "", level: p?.level ?? "" }), url: `${base}/profile/${p?.id ?? ""}` });
    if (r === "copied") toast.info(tNow("profile.linkCopied"));
  };
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div>
      <PageHeader eyebrow={own ? t("profile.dossier") : t("profile.record")} title={<En>{p?.username ?? "…"}</En>} actions={<NeonButton size="sm" variant="ghost" onClick={() => void onShare()} icon={<Icon name="share" size={14} />}>{t("profile.share")}</NeonButton>} />
      {!p ? <div className="nf-skeleton h-60" /> : (
        <div className="grid gap-5">
          <HoloPanel glow corners accent={f?.color}>
            <div className="flex flex-wrap items-center gap-5">
              <LevelHex level={p.level} size={74} />
              <div className="min-w-0 flex-1">
                <div className="nf-display text-[26px] font-bold tracking-[0.06em]">{p.username}</div>
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-dim">
                  {f && <span className="flex items-center gap-1"><FactionEmblem path={f.emblem} color={f.color} size={16} framed={false} />{f.name}</span>}
                  {p.clan && <span>· [{p.clan.tag}] {p.clan.name}</span>}
                  <span>· {rankLabel(p.rank)}</span>{p.prestige > 0 && <span>· {t("profile.prestige", { n: p.prestige })}</span>}{p.title && <span className="text-accent">· {p.title}</span>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div><div className="nf-label">{t("home.gearScore")}</div><div className="nf-display text-[22px] font-bold">{Math.round(p.gearScore)}</div></div>
                <div><div className="nf-label">{t("profile.ship")}</div><div className="nf-ui text-[16px] font-bold">{p.ship?.name ?? "—"}</div></div>
              </div>
            </div>
          </HoloPanel>
          <div className="grid gap-4 md:grid-cols-2">
            <HoloPanel title="PvP">
              <div className="grid grid-cols-4 gap-2 text-center">
                {([["profile.kills", p.pvp.kills], ["profile.deaths", p.pvp.deaths], ["profile.wins", p.pvp.wins], ["profile.rating", p.pvp.rating]] as const).map(([k, v]) => <div key={k}><div className="nf-label">{t(k)}</div><div className="nf-display text-[20px] font-bold">{fmtNum(v)}</div></div>)}
              </div>
            </HoloPanel>
            <HoloPanel title="PvE">
              <div className="grid grid-cols-3 gap-2 text-center">
                {([["profile.npcKills", p.pve.npcKills], ["profile.bosses", p.pve.bossKills], ["profile.gates", p.pve.gatesCompleted]] as const).map(([k, v]) => <div key={k}><div className="nf-label">{t(k)}</div><div className="nf-display text-[20px] font-bold">{fmtNum(v)}</div></div>)}
              </div>
            </HoloPanel>
          </div>
          {own ? (
            <>
              <Achievements />
              <div className="grid gap-4 md:grid-cols-2">
                <Rename />
                <Security />
              </div>
              <div className="text-[13px] text-dim"><Rich text={t("profile.walletsHint")} parts={{ wallet: <Link to="/wallet" className="nf-link">{t("nav.wallet")}</Link> }} /></div>
            </>
          ) : (
            <HoloPanel title={t("profile.recentAch")}>
              {p.achievements.length === 0 ? <div className="text-[13px] text-mute">{t("common.noneYet")}</div> : (
                <div className="flex flex-wrap gap-2">{p.achievements.map((a) => <span key={a.id} className="nf-chip" style={{ color: "var(--nf-credits)" }}><Icon name="trophy" size={11} />{a.name}</span>)}</div>
              )}
            </HoloPanel>
          )}
        </div>
      )}
    </div>
  );
}
