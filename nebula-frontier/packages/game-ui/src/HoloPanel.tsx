import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";

export interface HoloPanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
  /** Sci-fi clipped corners instead of rounded. */
  cut?: boolean;
  /** Hover lift + glow (use with onClick). */
  interactive?: boolean;
  glow?: boolean;
  corners?: boolean;
  /** Override the accent color for this panel only. */
  accent?: string;
  padded?: boolean;
  as?: "section" | "div" | "article" | "aside";
  children?: ReactNode;
}

export function HoloPanel({
  title, actions, cut, interactive, glow, corners, accent, padded = true, as = "section",
  className, style, children, ...rest
}: HoloPanelProps) {
  const Tag = as;
  const s: CSSProperties = accent ? ({ ...style, "--nf-accent": accent } as CSSProperties) : (style ?? {});
  return (
    <Tag
      className={cx("nf-panel", cut && "nf-panel--cut", interactive && "nf-panel--interactive", glow && "nf-panel--glow", className)}
      style={s}
      {...rest}
    >
      {corners && <span aria-hidden className="nf-panel__corner nf-panel__corner--tl" />}
      {corners && <span aria-hidden className="nf-panel__corner nf-panel__corner--br" />}
      {(title || actions) && (
        <header className="nf-panel__header">
          {typeof title === "string" ? <h2 className="nf-panel__title">{title}</h2> : title}
          {actions && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
        </header>
      )}
      {padded ? <div className="nf-panel__body">{children}</div> : children}
    </Tag>
  );
}
