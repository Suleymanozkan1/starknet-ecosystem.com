import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Prevent closing by backdrop click / Escape (e.g. while a transaction is signing). */
  locked?: boolean;
  className?: string;
}

export function Modal({ open, onClose, title, children, footer, wide, locked, className }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const prevFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !locked) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [open, locked]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="nf-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx("nf-panel nf-modal", wide && "nf-modal--wide", className)}
      >
        <header className="nf-panel__header">
          <h2 id={titleId} className="nf-panel__title">{title}</h2>
          {!locked && (
            <button type="button" className="nf-modal__close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          )}
        </header>
        <div className="nf-panel__body">{children}</div>
        {footer && <footer className="nf-modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
