import type { SVGProps } from "react";

/**
 * Inline SVG icon set (24x24, stroke based). Original line-art drawn for Nebula Frontier.
 * Each entry is a list of SVG path `d` strings; `circle:` prefixes draw circles `cx,cy,r`.
 */
const ICONS = {
  play: ["M7 4.5v15l12.5-7.5z"],
  galaxy: ["M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M12 3c5 0 9 2.5 9 5.5S15 12 12 12 3 14.5 3 17.5 7 21 12 21", "M3 8.5C3 5.5 7 3 12 3", "M21 15.5c0 3-4 5.5-9 5.5"],
  hangar: ["M3 20V9l9-5 9 5v11", "M7 20v-6h10v6", "M3 20h18", "M10 14l2-3 2 3"],
  inventory: ["M4 7h16v13H4z", "M9 7V4h6v3", "M4 12h16", "M11 12v2h2v-2"],
  ship: ["M12 2l3 8 6 3-6 2-3 7-3-7-6-2 6-3z", "M12 10v4"],
  weapon: ["M3 21l6-6", "M8 14l2 2", "M9 13l9-9h3v3l-9 9", "M14 8l2 2"],
  module: ["M6 6h12v12H6z", "M9 9h6v6H9z", "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"],
  drone: ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M5 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M19 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M5 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M19 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M7 7l2.5 2.5M17 7l-2.5 2.5M7 17l2.5-2.5M17 17l-2.5-2.5"],
  missions: ["M9 4h6l1 2h3v15H5V6h3z", "M9 12l2 2 4-4", "M9 17h6"],
  clan: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", "M9 12l2 2 4-4"],
  market: ["M4 9l1.5-5h13L20 9", "M4 9h16v11H4z", "M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0", "M10 20v-5h4v5"],
  auction: ["M14 4l6 6", "M11 7l6 6", "M12.5 5.5l6 6-3 3-6-6z", "M9.5 11.5L3 18l3 3 6.5-6.5", "M13 21h8"],
  leaderboard: ["M4 20V12h4v8", "M10 20V6h4v14", "M16 20v-5h4v5", "M3 20h18"],
  season: ["M12 2l2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z"],
  battlepass: ["M4 6h16v12H4z", "M4 10h16", "M8 14h3", "M15 14h1"],
  wallet: ["M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 7l12-3v3", "M16 13.5h.01"],
  shop: ["M6 7h12l-1 13H7z", "M9 7a3 3 0 0 1 6 0"],
  settings: ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9", "M13.7 21a2 2 0 0 1-3.4 0"],
  user: ["M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M4 21a8 8 0 0 1 16 0"],
  chat: ["M4 5h16v11H9l-5 4z", "M8 9h8M8 12h5"],
  mail: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M5 12l5 5L20 7"],
  lock: ["M6 11h12v10H6z", "M8 11V7a4 4 0 0 1 8 0v4"],
  star: ["M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"],
  credits: ["M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0", "M12 12m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0", "M12 7.5v9"],
  gems: ["M6 4h12l3 5-9 11L3 9z", "M3 9h18", "M9 4l3 16 3-16"],
  crypto: ["M12 2l8.5 5v10L12 22l-8.5-5V7z", "M12 7l4.3 2.5v5L12 17l-4.3-2.5v-5z"],
  shield: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"],
  hull: ["M4 17l8 4 8-4V7l-8-4-8 4z", "M4 7l8 4 8-4", "M12 11v10"],
  energy: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  target: ["M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0", "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M12 2v4M12 18v4M2 12h4M18 12h4"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  arrowLeft: ["M19 12H5", "M11 6l-6 6 6 6"],
  chevronDown: ["M6 9l6 6 6-6"],
  search: ["M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0", "M20 20l-4-4"],
  filter: ["M4 5h16l-6 8v6l-4-2v-4z"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  logout: ["M15 4h4v16h-4", "M10 16l-4-4 4-4", "M6 12h11"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  home: ["M3 11l9-7 9 7", "M5 10v10h14V10", "M10 20v-6h4v6"],
  crafting: ["M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 1.3-1.3a4 4 0 0 0-5-5L3 8.4 8.4 3z"],
  events: ["M4 5h16v15H4z", "M4 9h16", "M8 3v4M16 3v4", "M12 13l1 2 2 .3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1L9 15.3l2-.3z"],
  friends: ["M9 8m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0", "M2 20a7 7 0 0 1 14 0", "M16 4.5a3.5 3.5 0 0 1 0 7", "M18 14a7 7 0 0 1 4 6"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  refresh: ["M20 11a8 8 0 0 0-14.8-4", "M4 4v4h4", "M4 13a8 8 0 0 0 14.8 4", "M20 20v-4h-4"],
  warning: ["M12 3l10 18H2z", "M12 10v5", "M12 18h.01"],
  info: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 11v6", "M12 7.5h.01"],
  trophy: ["M8 4h8v5a4 4 0 0 1-8 0z", "M8 6H4v1a4 4 0 0 0 4 4", "M16 6h4v1a4 4 0 0 1-4 4", "M12 13v4", "M8 21h8", "M9 17h6v4H9z"],
  crown: ["M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"],
  rocket: ["M12 2c4 3 5 8 4 13H8C7 10 8 5 12 2z", "M8 15l-3 3 1 3 3-2", "M16 15l3 3-1 3-3-2", "M12 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"],
  dash: ["M3 12h10", "M5 8h6", "M5 16h6", "M13 6l7 6-7 6z"],
  emp: ["M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M6.3 6.3a8 8 0 0 0 0 11.4", "M17.7 6.3a8 8 0 0 1 0 11.4", "M3.5 3.5a12 12 0 0 0 0 17", "M20.5 3.5a12 12 0 0 1 0 17"],
  ultimate: ["M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z", "M12 8v5"],
  fire: ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M12 2v5M12 17v5M2 12h5M17 12h5"],
  zap: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  map: ["M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z", "M9 4v14M15 6v14"],
  repair: ["M14.7 6.3a4 4 0 0 0 5 5L12 19l-3 3-4-4 3-3z", "M5 5l4 4"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  sword: ["M14.5 17.5L3 6V3h3l11.5 11.5", "M13 19l6-6", "M16 16l4 4", "M19 21l2-2"],
  station: ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M12 3v6M12 15v6M3 12h6M15 12h6", "M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"],
  pickaxe: ["M3 21l9-9", "M14 4c3 0 6 2 7 5-3-1-5-1-7 0", "M14 4c0 3-1 5 0 7", "M11 7l6 6"],
  signal: ["M4 20v-3M9 20v-7M14 20V9M19 20V4"],
  globe: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M3 12h18", "M12 3a14 14 0 0 1 0 18", "M12 3a14 14 0 0 0 0 18"],
  fingerprint: ["M7 11a5 5 0 0 1 10 0v2", "M12 11v4a6 6 0 0 1-2 4.5", "M4 12a8 8 0 0 1 16 0v1", "M17 15a13 13 0 0 1-1 5"],
  share: ["M18 5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M6 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M18 19m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5"],
  swap: ["M7 4L3 8l4 4", "M3 8h14", "M17 12l4 4-4 4", "M21 16H7"],
  clock: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3 2"],
  volume: ["M4 9h4l5-4v14l-5-4H4z", "M16 9a4 4 0 0 1 0 6", "M19 6a8 8 0 0 1 0 12"],
  gamepad: ["M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L13.5 14h-3L9 15.6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z", "M7 10v4M5 12h4", "M16 11h.01M18 13h.01"],
  profile: ["M4 4h16v16H4z", "M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M7 18a5 5 0 0 1 10 0"],
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  title?: string;
}

export function Icon({ name, size = 20, strokeWidth = 1.7, title, ...rest }: IconProps) {
  const paths = ICONS[name];
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title && <title>{title}</title>}
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
