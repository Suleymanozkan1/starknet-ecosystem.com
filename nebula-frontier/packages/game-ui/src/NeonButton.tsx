import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { cx } from "./cx.js";

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg" | "xl";
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  /** Override the button color. */
  color?: string;
}

export function NeonButton({
  variant = "default", size = "md", block, loading, icon, color, className, style, children, disabled, type = "button", ...rest
}: NeonButtonProps) {
  const s: CSSProperties = color ? ({ ...style, "--btn-c": color } as CSSProperties) : (style ?? {});
  return (
    <button
      type={type}
      className={cx(
        "nf-btn",
        variant !== "default" && `nf-btn--${variant}`,
        size !== "md" && `nf-btn--${size}`,
        block && "nf-btn--block",
        className,
      )}
      style={s}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="nf-btn__spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}
