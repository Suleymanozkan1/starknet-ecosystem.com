import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CurrencyAmount, HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { FriendUser } from "../lib/dto.js";
import { qk, useApiMutation, useBounties, useFriends, useSquad } from "../lib/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { useSession } from "../hooks/useSession.js";
import { useT } from "../lib/i18n.js";

function Row({ f, children }: { f: FriendUser; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-black/20 px-3 py-2">
      <span className={`h-2.5 w-2.5 rounded-full ${f.online ? "bg-good shadow-[0_0_8px_var(--nf-good)]" : "bg-white/15"}`} aria-label={f.online ? t("friends.online") : t("friends.offline")} />
      <Link to={`/profile/${f.id}`} className="nf-ui min-w-0 flex-1 truncate text-[15px] font-bold text-ink no-underline hover:text-accent">{f.username}</Link>
      <span className="nf-label">{t("common.lvN", { n: f.level })}</span>
      {children}
    </div>
  );
}

export default function FriendsPage() {
  const t = useT();
  const me = useSession();
  const friends = useFriends();
  const squad = useSquad();
  const bounties = useBounties();
  const [name, setName] = useState("");
  const inv = [qk.friends];
  const add = useApiMutation((v: { username: string } | { userId: string }) => api.friends.add(v), { invalidate: inv, success: (r) => (r.status === "ACCEPTED" ? t("friends.nowFriends") : t("friends.requestSent")), onSuccess: () => setName("") });
  const remove = useApiMutation((userId: string) => api.friends.remove(userId), { invalidate: inv, success: t("friends.removed") });
  const block = useApiMutation((userId: string) => api.friends.block(userId), { invalidate: inv, success: t("friends.blocked") });
  const unblock = useApiMutation((userId: string) => api.friends.unblock(userId), { invalidate: inv, success: t("friends.unblocked") });
  const createSquad = useApiMutation(() => api.squad.create(), { invalidate: [qk.squad], success: t("friends.squadFormed") });
  const invite = useApiMutation((userId: string) => api.squad.invite(userId), { success: t("friends.inviteSent") });
  const leaveSquad = useApiMutation(() => api.squad.leave(), { invalidate: [qk.squad], success: t("friends.leftSquad") });
  const isLeader = squad.data?.leaderId === me.id;

  return (
    <div>
      <PageHeader eyebrow={t("friends.eyebrow")} title={t("friends.title")} />
      <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
        <div className="grid content-start gap-5">
          <HoloPanel title={t("friends.add")}>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (/^[A-Za-z0-9_]{3,20}$/.test(name)) add.mutate({ username: name }); }}>
              <input className="nf-input" placeholder={t("auth.username")} value={name} maxLength={20} onChange={(e) => setName(e.target.value.trim())} aria-label={t("auth.username")} />
              <NeonButton type="submit" loading={add.isPending} disabled={!/^[A-Za-z0-9_]{3,20}$/.test(name)}>{t("friends.addBtn")}</NeonButton>
            </form>
          </HoloPanel>
          <QueryState q={friends}>
            {(d) => (
              <div className="grid gap-5">
                {d.incoming.length > 0 && (
                  <HoloPanel title={t("friends.requests", { n: d.incoming.length })} glow>
                    <div className="grid gap-2">{d.incoming.map((f) => <Row key={f.id} f={f}><NeonButton size="sm" variant="success" onClick={() => add.mutate({ userId: f.id })}>{t("common.accept")}</NeonButton><NeonButton size="sm" variant="ghost" onClick={() => remove.mutate(f.id)}>{t("friends.decline")}</NeonButton></Row>)}</div>
                  </HoloPanel>
                )}
                <HoloPanel title={t("friends.friendsN", { n: d.friends.length })}>
                  {d.friends.length === 0 ? <EmptyState title={t("friends.noneTitle")} body={t("friends.noneBody")} icon="friends" /> : (
                    <div className="grid gap-2">
                      {[...d.friends].sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online))).map((f) => (
                        <Row key={f.id} f={f}>
                          {isLeader && <button type="button" className="nf-iconbtn h-8 w-8" aria-label={t("friends.inviteAria", { name: f.username })} onClick={() => invite.mutate(f.id)}><Icon name="plus" size={15} /></button>}
                          <button type="button" className="nf-iconbtn h-8 w-8" aria-label={t("friends.removeAria", { name: f.username })} onClick={() => remove.mutate(f.id)}><Icon name="close" size={15} /></button>
                          <button type="button" className="nf-iconbtn h-8 w-8" aria-label={t("friends.blockAria", { name: f.username })} onClick={() => block.mutate(f.id)}><Icon name="lock" size={14} /></button>
                        </Row>
                      ))}
                    </div>
                  )}
                </HoloPanel>
                {d.outgoing.length > 0 && <HoloPanel title={t("friends.pending")}><div className="grid gap-2">{d.outgoing.map((f) => <Row key={f.id} f={f}><span className="nf-label">{t("friends.sent")}</span></Row>)}</div></HoloPanel>}
                {d.blocked.length > 0 && <HoloPanel title={t("friends.blockedTitle")}><div className="grid gap-2">{d.blocked.map((f) => <Row key={f.id} f={f}><NeonButton size="sm" variant="ghost" onClick={() => unblock.mutate(f.id)}>{t("friends.unblock")}</NeonButton></Row>)}</div></HoloPanel>}
              </div>
            )}
          </QueryState>
          <HoloPanel title={t("friends.bountyBoard")} accent="#f43f5e">
            <QueryState q={bounties} isEmpty={(d) => d.length === 0} empty={<div className="text-[13px] text-mute">{t("friends.noBounties")}</div>}>
              {(list) => (
                <table className="nf-table">
                  <thead><tr><th>{t("friends.target")}</th><th>{t("common.level")}</th><th>{t("friends.bounties")}</th><th className="text-right">{t("friends.total")}</th></tr></thead>
                  <tbody>{list.map((b) => <tr key={b.targetId}><td><Link to={`/profile/${b.targetId}`} className="nf-ui font-bold text-ink no-underline hover:text-accent">{b.username ?? t("common.unknown")}</Link></td><td>{b.level ?? "—"}</td><td>{b.count}</td><td className="text-right"><CurrencyAmount amount={b.total} currency="CREDITS" size={14} /></td></tr>)}</tbody>
                </table>
              )}
            </QueryState>
          </HoloPanel>
        </div>
        <div className="grid content-start gap-5">
          <HoloPanel title={t("friends.squad")}>
            {squad.isLoading ? <div className="nf-skeleton h-24" /> : squad.data ? (
              <div className="grid gap-2">
                {squad.data.members.map((m) => (
                  <div key={m.userId} className="flex items-center gap-2 text-[14px]">
                    <span className={`h-2 w-2 rounded-full ${m.online ? "bg-good" : "bg-white/15"}`} />
                    <span className="nf-ui flex-1 font-bold">{m.username}</span>
                    {m.userId === squad.data!.leaderId && <Icon name="crown" size={14} style={{ color: "var(--nf-credits)" }} />}
                    <span className="nf-label">{t("common.lvN", { n: m.level })}</span>
                  </div>
                ))}
                <div className="text-[12px] text-mute">{t("friends.squadPilots", { n: squad.data.members.length, max: squad.data.maxSize })} {isLeader ? t("friends.inviteHint") : ""}</div>
                <NeonButton size="sm" variant="ghost" loading={leaveSquad.isPending} onClick={() => leaveSquad.mutate(undefined)}>{t("friends.leaveSquad")}</NeonButton>
              </div>
            ) : (
              <div className="grid gap-2">
                <div className="text-[13px] text-mute">{t("friends.squadInfo")}</div>
                <NeonButton size="sm" variant="primary" loading={createSquad.isPending} onClick={() => createSquad.mutate(undefined)}>{t("friends.formSquad")}</NeonButton>
              </div>
            )}
          </HoloPanel>
          <div className="h-[520px]"><ChatPanel me={me} embedded /></div>
        </div>
      </div>
    </div>
  );
}
