import type { IconName } from "@nebula/game-ui";
import type { TKey } from "../lib/i18n.js";

export interface NavItem { to: string; label: TKey; icon: IconName }

/** Main menu (desktop side nav) in the order requested by design. */
export const MAIN_MENU: NavItem[] = [
  { to: "/play", label: "nav.play", icon: "play" },
  { to: "/galaxy", label: "nav.galaxy", icon: "galaxy" },
  { to: "/hangar", label: "nav.hangar", icon: "hangar" },
  { to: "/inventory", label: "nav.inventory", icon: "inventory" },
  { to: "/ships", label: "nav.ships", icon: "ship" },
  { to: "/weapons", label: "nav.weapons", icon: "weapon" },
  { to: "/modules", label: "nav.modules", icon: "module" },
  { to: "/drones", label: "nav.drones", icon: "drone" },
  { to: "/missions", label: "nav.missions", icon: "missions" },
  { to: "/clan", label: "nav.clan", icon: "clan" },
  { to: "/market", label: "nav.market", icon: "market" },
  { to: "/auction", label: "nav.auction", icon: "auction" },
  { to: "/leaderboard", label: "nav.leaderboard", icon: "leaderboard" },
  { to: "/season", label: "nav.season", icon: "season" },
  { to: "/battle-pass", label: "nav.battlepass", icon: "battlepass" },
  { to: "/wallet", label: "nav.wallet", icon: "wallet" },
  { to: "/shop", label: "nav.shop", icon: "shop" },
  { to: "/settings", label: "nav.settings", icon: "settings" },
];

export const SECONDARY_MENU: NavItem[] = [
  { to: "/crafting", label: "nav.crafting", icon: "crafting" },
  { to: "/events", label: "nav.events", icon: "events" },
  { to: "/friends", label: "nav.friends", icon: "friends" },
  { to: "/mail", label: "nav.mail", icon: "mail" },
  { to: "/profile", label: "nav.profile", icon: "profile" },
];

/** Mobile bottom navigation. */
export const BOTTOM_NAV: NavItem[] = [
  { to: "/home", label: "nav.home", icon: "home" },
  { to: "/hangar", label: "nav.hangar", icon: "hangar" },
  { to: "/galaxy", label: "nav.galaxy", icon: "galaxy" },
  { to: "/clan", label: "nav.clan", icon: "clan" },
  { to: "/shop", label: "nav.shop", icon: "shop" },
  { to: "/wallet", label: "nav.wallet", icon: "wallet" },
];
