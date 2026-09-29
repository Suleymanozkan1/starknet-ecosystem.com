import { Fragment } from "react";
import type { ReactNode } from "react";

/**
 * Marks an English proper noun (ship / item / map / faction name, callsign…) so CSS `text-transform: uppercase`
 * uses English casing rules even when the page language is Turkish ("Orion" → "ORION", not "ORİON").
 */
export function En({ children }: { children: ReactNode }) {
  return <span lang="en">{children}</span>;
}

/**
 * Renders a translated template containing `{name}` placeholders, substituting React nodes
 * (e.g. `<b>` highlights, links, currency amounts) so word order can differ per language.
 */
export function Rich({ text, parts }: { text: string; parts: Readonly<Record<string, ReactNode>> }) {
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m[1] ?? "";
    out.push(<Fragment key={`p${i++}`}>{key in parts ? parts[key] : m[0]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
