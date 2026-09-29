import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { tNow, translateServerText } from "../lib/i18n.js";

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (e: Error, reset: () => void) => ReactNode }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UI crashed", error, info.componentStack);
  }
  reset = (): void => this.setState({ error: null });
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="grid min-h-[60vh] place-items-center p-6 text-center">
        <div className="nf-panel grid max-w-md gap-3 p-6">
          <div className="nf-eyebrow" style={{ color: "var(--nf-bad)" }}>{tNow("error.systemFault")}</div>
          <div className="nf-ui text-[18px] font-bold uppercase">{tNow("error.panelFailed")}</div>
          <p className="text-[13px] text-dim">{translateServerText(error.message)}</p>
          <button type="button" className="nf-btn" onClick={this.reset}>{tNow("error.reloadPanel")}</button>
        </div>
      </div>
    );
  }
}
