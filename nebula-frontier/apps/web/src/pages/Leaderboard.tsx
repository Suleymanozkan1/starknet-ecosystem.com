import { useState } from "react";
import { Link } from "react-router-dom";
import { FactionEmblem, HoloPanel, Icon, Tabs } from "@nebula/game-ui";
import { useLeaderboard } from "../lib/queries.js";
import { faction } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { useSession } from "../hooks/useSession.js";
import { fmtNum, useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";

const BOARDS = [
  { key: "honor", label: "lb.honor", score: "lb.honor" },
  { key: "pvp_kills", label: "lb.pvp", score: "lb.kills" },
  { key: "npc_kills", label: "lb.pve", score: "lb.npcKills" },
  { key: "season_score", label: "lb.season", score: "lb.seasonPts" },
  { key: "clan", label: "lb.clans", score: "common.score" },
  { key: "faction", label: "lb.factions", score: "common.score" },
] as const satisfies readonly { key: string; label: TKey; score: TKey }[];
type Board = (typeof BOARDS)[number]["key"];
const PODIUM = ["#fbbf24", "#cbd5e1", "#d97706"];

export default function LeaderboardPage() {
  const t = useT();
  const me = useSession();
  const [board, setBoard] = useState<Board>("honor");
  const q = useLeaderboard(board);
  const meta = BOARDS.find((b) => b.key === board)!;
  const entity = board === "clan" ? t("lb.clan") : board === "faction" ? t("common.faction") : t("lb.pilot");
  return (
    <div>
      <PageHeader eyebrow={t("lb.eyebrow")} title={t("lb.title")} subtitle={t("lb.subtitle")} />
      <Tabs className="mb-4" value={board} onChange={setBoard} items={BOARDS.map((b) => ({ key: b.key, label: t(b.label) }))} />
      <QueryState q={q} isEmpty={(d) => d.entries.length === 0} empty={<EmptyState title={t("lb.empty")} icon="leaderboard" />}>
        {(d) => (
          <div className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {d.entries.slice(0, 3).map((e, i) => {
                const f = faction(e.faction);
                return (
                  <HoloPanel key={e.userId} accent={PODIUM[i]} glow className={i === 0 ? "sm:order-2 sm:-translate-y-3" : i === 1 ? "sm:order-1" : "sm:order-3"}>
                    <div className="grid justify-items-center gap-2 text-center">
                      <span style={{ color: PODIUM[i] }}><Icon name={i === 0 ? "crown" : "trophy"} size={30} /></span>
                      <div className="nf-display text-[32px] font-black" style={{ color: PODIUM[i] }}>#{e.rank}</div>
                      <div className="flex items-center gap-2">
                        {f && <FactionEmblem path={f.emblem} color={f.color} size={20} framed={false} />}
                        <span className="nf-ui text-[18px] font-bold">{e.clanTag && board !== "clan" && board !== "faction" ? `[${e.clanTag}] ` : ""}{e.username}</span>
                      </div>
                      <div className="nf-display text-[20px] font-bold tabular-nums">{fmtNum(BigInt(e.score))}</div>
                      <div className="nf-label">{t(meta.score)}</div>
                    </div>
                  </HoloPanel>
                );
              })}
            </div>
            <HoloPanel padded={false}>
              <div className="overflow-x-auto">
                <table className="nf-table">
                  <thead><tr><th className="w-16">#</th><th>{entity}</th><th>{board === "faction" ? t("lb.territory") : t("common.level")}</th><th className="text-right">{t(meta.score)}</th></tr></thead>
                  <tbody>
                    {d.entries.map((e) => {
                      const f = faction(e.faction);
                      const isMe = e.userId === me.id;
                      return (
                        <tr key={e.userId} style={isMe ? { background: "color-mix(in oklab, var(--nf-accent) 10%, transparent)" } : undefined}>
                          <td className="nf-display font-bold tabular-nums" style={{ color: PODIUM[e.rank - 1] }}>{e.rank}</td>
                          <td>
                            <div className="flex items-center gap-2">
                              {f && <FactionEmblem path={f.emblem} color={f.color} size={18} framed={false} />}
                              {board === "clan" ? <Link to={`/clan/${e.userId}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">[{e.clanTag}] {e.username}</Link>
                                : board === "faction" ? <span className="nf-ui text-[15px] font-bold">{e.username}</span>
                                : <Link to={`/profile/${e.userId}`} className="nf-ui text-[15px] font-bold text-ink no-underline hover:text-accent">{e.clanTag ? <span className="text-accent">[{e.clanTag}] </span> : null}{e.username}</Link>}
                              {isMe && <span className="nf-chip text-[10px]">{t("common.you")}</span>}
                            </div>
                          </td>
                          <td className="tabular-nums text-dim">{e.level}</td>
                          <td className="nf-ui text-right text-[15px] font-bold tabular-nums">{fmtNum(BigInt(e.score))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </HoloPanel>
          </div>
        )}
      </QueryState>
    </div>
  );
}
