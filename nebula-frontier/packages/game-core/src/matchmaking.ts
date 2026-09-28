/**
 * Rating (Elo / team Elo) and match formation by rating, level, gear score,
 * region, latency and party, with tolerance widening over queue time.
 */
import type { Region } from "@nebula/shared";

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

/** Elo update. `scoreA` = 1 win, 0.5 draw, 0 loss. Returns integer deltas. */
export function eloUpdate(ra: number, rb: number, scoreA: number, k = 32): { a: number; b: number; deltaA: number; deltaB: number } {
  const ea = expectedScore(ra, rb);
  const deltaA = Math.round(k * (scoreA - ea));
  const deltaB = -deltaA;
  return { a: ra + deltaA, b: rb + deltaB, deltaA, deltaB };
}

/** K-factor that shrinks with experience (provisional players move faster). */
export function kFactor(matchesPlayed: number): number {
  if (matchesPlayed < 10) return 48;
  if (matchesPlayed < 50) return 32;
  return 24;
}

/**
 * Team rating update: each player's delta is computed vs the opposing team's
 * average and scaled by their own K.
 */
export function teamRatingDeltas(
  teams: { userId: string; rating: number; matches: number }[][],
  winnerTeam: number | null,
): Map<string, number> {
  const avg = teams.map((t) => (t.length ? t.reduce((s, p) => s + p.rating, 0) / t.length : 1200));
  const out = new Map<string, number>();
  teams.forEach((team, ti) => {
    const others = avg.filter((_, j) => j !== ti);
    const opp = others.length ? others.reduce((a, b) => a + b, 0) / others.length : avg[ti] ?? 1200;
    const score = winnerTeam === null ? 0.5 : winnerTeam === ti ? 1 : 0;
    for (const p of team) {
      const exp = expectedScore(avg[ti] ?? p.rating, opp);
      out.set(p.userId, Math.round(kFactor(p.matches) * (score - exp)));
    }
  });
  return out;
}

export interface QueueTicket {
  userId: string;
  rating: number;
  level: number;
  gearScore: number;
  region: Region | string;
  latencyMs: number;
  partyId?: string | null;
  enqueuedAt: number;
}

export interface MatchRules {
  teamSize: number;
  teams: number;
  baseRatingSpread: number;
  ratingSpreadPerSec: number;
  maxRatingSpread: number;
  maxLevelSpread: number;
  maxGearSpreadRatio: number;
  maxLatencyMs: number;
}

export const DEFAULT_MATCH_RULES: MatchRules = {
  teamSize: 5, teams: 2, baseRatingSpread: 100, ratingSpreadPerSec: 10, maxRatingSpread: 600,
  maxLevelSpread: 10, maxGearSpreadRatio: 0.5, maxLatencyMs: 180,
};

export interface FormedMatch {
  teams: QueueTicket[][];
  averageRating: number;
  region: string;
}

function spreadFor(t: QueueTicket, now: number, rules: MatchRules): number {
  return Math.min(rules.maxRatingSpread, rules.baseRatingSpread + ((now - t.enqueuedAt) / 1000) * rules.ratingSpreadPerSec);
}

/**
 * Greedy match formation. Parties are kept together on the same team. Players
 * are grouped per region, sorted by rating, and a window is accepted when every
 * member is within everyone's (time-widened) tolerance. Teams are balanced by
 * snake draft on rating.
 */
export function formMatches(tickets: QueueTicket[], now: number, rules: MatchRules = DEFAULT_MATCH_RULES): { matches: FormedMatch[]; remaining: QueueTicket[] } {
  const need = rules.teamSize * rules.teams;
  // 1) Build units (parties or solos) BEFORE any filtering so a party is never split.
  const allUnits = new Map<string, QueueTicket[]>();
  for (const t of tickets) {
    const key = t.partyId ? `party:${t.partyId}` : `solo:${t.userId}`;
    const u = allUnits.get(key) ?? [];
    u.push(t);
    allUnits.set(key, u);
  }
  // 2) A unit is rejected as a whole if any member exceeds the latency limit; it is matched in
  //    ONE region (the party leader's = first ticket's region), so members cannot be split.
  const byRegion = new Map<string, QueueTicket[][]>();
  for (const u of allUnits.values()) {
    if (u.some((m) => m.latencyMs > rules.maxLatencyMs)) continue;
    const region = String(u[0]?.region ?? "");
    const arr = byRegion.get(region) ?? [];
    arr.push(u);
    byRegion.set(region, arr);
  }
  const used = new Set<string>();
  const matches: FormedMatch[] = [];
  for (const [region, units] of byRegion) {
    const unitList = units.filter((u) => u.length <= rules.teamSize)
      .map((u) => ({ members: u, rating: u.reduce((s, p) => s + p.rating, 0) / u.length, enq: Math.min(...u.map((p) => p.enqueuedAt)) }))
      .sort((a, b) => a.rating - b.rating);
    let i = 0;
    while (i < unitList.length) {
      const group: typeof unitList = [];
      let count = 0;
      for (let j = i; j < unitList.length && count < need; j++) {
        const u = unitList[j];
        if (!u || u.members.some((m) => used.has(m.userId))) continue;
        if (count + u.members.length > need) continue;
        const candidate = [...group, u];
        const members = candidate.flatMap((c) => c.members);
        const minR = Math.min(...members.map((m) => m.rating));
        const maxR = Math.max(...members.map((m) => m.rating));
        const tol = Math.min(...members.map((m) => spreadFor(m, now, rules)));
        const minL = Math.min(...members.map((m) => m.level));
        const maxL = Math.max(...members.map((m) => m.level));
        const minG = Math.min(...members.map((m) => m.gearScore));
        const maxG = Math.max(...members.map((m) => m.gearScore));
        const gearOk = maxG === 0 || (maxG - minG) / Math.max(1, maxG) <= rules.maxGearSpreadRatio;
        if (maxR - minR <= tol && maxL - minL <= rules.maxLevelSpread && gearOk) {
          group.push(u);
          count += u.members.length;
        }
      }
      if (count === need) {
        const teams = assignTeams(group.map((g) => g.members), rules);
        if (teams) {
          for (const g of group) for (const m of g.members) used.add(m.userId);
          const all = teams.flat();
          matches.push({ teams, averageRating: all.reduce((s, p) => s + p.rating, 0) / all.length, region });
        }
      }
      i++;
    }
  }
  return { matches, remaining: tickets.filter((t) => !used.has(t.userId)) };
}

function assignTeams(units: QueueTicket[][], rules: MatchRules): QueueTicket[][] | null {
  const teams: QueueTicket[][] = Array.from({ length: rules.teams }, () => []);
  const sorted = [...units].sort((a, b) => b.length - a.length || avg(b) - avg(a));
  for (const u of sorted) {
    // Put unit on the team with the lowest total rating that still has room.
    let best = -1;
    let bestSum = Infinity;
    teams.forEach((t, idx) => {
      if (t.length + u.length > rules.teamSize) return;
      const sum = t.reduce((s, p) => s + p.rating, 0);
      if (sum < bestSum) { bestSum = sum; best = idx; }
    });
    if (best < 0) return null;
    teams[best]?.push(...u);
  }
  return teams;
}

function avg(u: QueueTicket[]): number {
  return u.reduce((s, p) => s + p.rating, 0) / Math.max(1, u.length);
}
