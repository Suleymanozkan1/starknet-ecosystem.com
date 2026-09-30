/** ARIA page guide: first-visit explanation of every main shell page (pure data + route matching). */
import type { TKey } from "../lib/i18n.js";

export interface PageTip {
  id: string;
  title: TKey;
  body: TKey;
  /** Extra sentence shown only in the demo build. */
  demoNote?: TKey;
}

const tip = (id: string, demoNote?: TKey): PageTip => ({
  id,
  title: `aria.page.${id}.title` as TKey,
  body: `aria.page.${id}.body` as TKey,
  ...(demoNote ? { demoNote } : {}),
});

/** First path segment → page tip. */
export const PAGE_TIPS: Readonly<Record<string, PageTip>> = {
  home: tip("home"),
  hangar: tip("hangar"),
  ships: tip("ships"),
  inventory: tip("inventory"),
  weapons: tip("weapons"),
  modules: tip("modules"),
  drones: tip("drones"),
  missions: tip("missions"),
  crafting: tip("crafting"),
  galaxy: tip("galaxy"),
  clan: tip("clan"),
  market: tip("market"),
  auction: tip("auction"),
  leaderboard: tip("leaderboard"),
  season: tip("season"),
  "battle-pass": tip("battlepass"),
  events: tip("events"),
  shop: tip("shop"),
  wallet: tip("wallet", "aria.page.wallet.demo"),
  profile: tip("profile"),
  friends: tip("friends"),
  mail: tip("mail"),
  notifications: tip("notifications"),
  settings: tip("settings"),
};

/** Page tip for a pathname ("/clan/abc" → clan), or null for pages without one. */
export function pageTipFor(pathname: string): PageTip | null {
  const seg = pathname.split("/").filter(Boolean)[0] ?? "";
  return Object.hasOwn(PAGE_TIPS, seg) ? (PAGE_TIPS[seg] ?? null) : null;
}

export function pageTipKey(t: PageTip): string {
  return `page:${t.id}`;
}
