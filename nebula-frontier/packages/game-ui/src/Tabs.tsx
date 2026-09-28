import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "./cx.js";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  variant?: "underline" | "pill";
  className?: string;
  ariaLabel?: string;
}

export function Tabs<K extends string>({ items, value, onChange, variant = "underline", className, ariaLabel }: TabsProps<K>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.key === value);
    const next = enabled[(idx + (e.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
    if (next) {
      onChange(next.key);
      ref.current?.querySelector<HTMLButtonElement>(`[data-key="${next.key}"]`)?.focus();
    }
  };
  return (
    <div ref={ref} role="tablist" aria-label={ariaLabel} className={cx("nf-tabs", variant === "pill" && "nf-tabs--pill", className)} onKeyDown={onKey}>
      {items.map((it) => (
        <button
          key={it.key}
          data-key={it.key}
          type="button"
          role="tab"
          className="nf-tab"
          aria-selected={it.key === value}
          tabIndex={it.key === value ? 0 : -1}
          disabled={it.disabled}
          onClick={() => onChange(it.key)}
        >
          {it.label}
          {it.count !== undefined && <span className="nf-tab__count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
