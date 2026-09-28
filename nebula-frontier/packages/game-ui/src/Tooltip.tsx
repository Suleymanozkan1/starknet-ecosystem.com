import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx.js";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: "top" | "bottom";
  className?: string;
}

/** Hover/focus tooltip; on touch devices a tap toggles it. */
export function Tooltip({ content, children, placement = "top", className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cx("nf-tooltip-wrap", className)}
      aria-describedby={id}
      onTouchStart={() => setOpen((o) => !o)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      <span id={id} role="tooltip" data-open={open} className={cx("nf-tooltip", placement === "bottom" && "nf-tooltip--bottom")}>
        {content}
      </span>
    </span>
  );
}
