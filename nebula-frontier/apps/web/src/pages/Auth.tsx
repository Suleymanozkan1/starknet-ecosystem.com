import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { HoloPanel, Icon, NeonButton, Tabs } from "@nebula/game-ui";
import type { MeResponse } from "@nebula/shared";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { useT } from "../lib/i18n.js";
import { qk } from "../lib/queries.js";
import { postLoginRoute } from "../routes/guards.js";
import { getDeviceId } from "../native/secureStorage.js";
import { haptic } from "../native/haptics.js";
import { useWalletAuth } from "../wallet/useWalletAuth.js";
import { shortAddr } from "../lib/gameMeta.js";
import { DEMO_MODE } from "../lib/demoMode.js";

const STEPS = [
  { key: "connecting", label: "Connect wallet" },
  { key: "nonce", label: "Request challenge" },
  { key: "signing", label: "Sign message" },
  { key: "verifying", label: "Verify signature" },
] as const;

function WalletSignIn({ onAuthed }: { onAuthed: (u: MeResponse) => void }) {
  const t = useT();
  const w = useWalletAuth((u) => { if (u) onAuthed(u); });
  const activeIdx = STEPS.findIndex((s) => s.key === w.phase);
  return (
    <div className="grid gap-4">
      <p className="m-0 text-[14px] leading-relaxed text-dim">
        Connect Phantom, Solflare, Backpack or any Wallet Standard wallet and sign a one-time challenge. No transaction is sent and
        no funds move. The challenge is single-use and expires in minutes.
      </p>
      <NeonButton variant="primary" size="lg" block loading={w.busy} onClick={() => { haptic("light"); w.start("LOGIN"); }} icon={<Icon name="wallet" size={18} />} data-testid="wallet-signin">
        {w.address ? `Sign in as ${shortAddr(w.address)}` : t("auth.wallet")}
      </NeonButton>
      {(w.busy || w.phase === "done") && (
        <ol className="m-0 grid list-none gap-1.5 p-0">
          {STEPS.map((s, i) => {
            const done = w.phase === "done" || i < activeIdx;
            const current = i === activeIdx;
            return (
              <li key={s.key} className="nf-ui flex items-center gap-2 text-[13px] uppercase tracking-[0.14em]" style={{ color: done ? "var(--nf-good)" : current ? "var(--nf-accent)" : "var(--nf-text-mute)" }}>
                {done ? <Icon name="check" size={14} /> : current ? <span className="nf-btn__spinner" /> : <span className="inline-block h-[14px] w-[14px] rounded-full border border-current" />}
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      {w.error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">{w.error}</div>}
      {w.address && !w.busy && (
        <button type="button" className="nf-ui justify-self-start text-[12px] uppercase tracking-[0.16em] text-mute hover:text-ink" onClick={() => void w.disconnect()}>
          Use a different wallet ({w.walletName})
        </button>
      )}
    </div>
  );
}

function EmailForm({ mode, onAuthed }: { mode: "login" | "register"; onAuthed: (u: MeResponse) => void }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (mode === "register" && !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      setError("Callsign must be 3–20 characters: letters, digits or underscore.");
      return;
    }
    if (password.length < (mode === "register" ? 10 : 1)) {
      setError("Password must be at least 10 characters.");
      return;
    }
    setBusy(true);
    try {
      const deviceId = await getDeviceId();
      const res = mode === "register" ? await api.auth.register({ email, password, username, deviceId }) : await api.auth.login({ email, password, deviceId });
      haptic("success");
      onAuthed(res.user);
    } catch (err) {
      haptic("error");
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={(e) => void submit(e)} noValidate>
      {mode === "register" && (
        <label className="grid gap-1.5">
          <span className="nf-label">{t("auth.username")}</span>
          <input className="nf-input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={20} required name="username" />
        </label>
      )}
      <label className="grid gap-1.5">
        <span className="nf-label">{t("auth.email")}</span>
        <input className="nf-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required name="email" />
      </label>
      <label className="grid gap-1.5">
        <span className="nf-label">{t("auth.password")}</span>
        <input className="nf-input" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 10 : 1} name="password" />
      </label>
      {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">{error}</div>}
      <NeonButton type="submit" variant="primary" size="lg" block loading={busy} data-testid="email-submit">
        {mode === "register" ? t("auth.register") : t("auth.login")}
      </NeonButton>
    </form>
  );
}

/** Demo build: one click creates a local pilot (the mock backend accepts any credentials). */
function DemoQuickStart({ onAuthed }: { onAuthed: (u: MeResponse) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const n = new Uint16Array(1);
      crypto.getRandomValues(n);
      const username = `Pilot_${String((n[0] ?? 0) % 10000).padStart(4, "0")}`;
      const res = await api.auth.register({ email: `${username.toLowerCase()}@demo.local`, password: "demo-pilot-local-1", username });
      haptic("success");
      onAuthed(res.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 rounded-md border border-warn/40 bg-warn/10 p-3">
      <p className="m-0 text-[13px] leading-relaxed text-dim">
        This is an offline demo: accounts, progress and balances live only in this browser. Wallet sign-in and on-chain features are disabled.
      </p>
      <NeonButton variant="primary" size="lg" block loading={busy} onClick={() => void start()} data-testid="demo-start">Start as demo pilot</NeonButton>
      {error && <div role="alert" className="text-[13px] text-bad">{error}</div>}
    </div>
  );
}

export default function AuthPage({ mode }: { mode: "login" | "register" }) {
  const [method, setMethod] = useState<"wallet" | "email">(DEMO_MODE ? "email" : "wallet");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();

  const onAuthed = (user: MeResponse): void => {
    qc.setQueryData(qk.me, user);
    void qc.invalidateQueries({ queryKey: qk.me });
    navigate(postLoginRoute(user, params.get("next")), { replace: true });
  };

  return (
    <div className="relative z-10 grid min-h-screen place-items-center px-4 py-[calc(24px+var(--safe-top))]">
      <div className="grid w-full max-w-[980px] items-center gap-8 md:grid-cols-[1.1fr_1fr]">
        <div className="hidden gap-5 md:grid">
          <Link to="/" className="nf-logo text-[18px] text-ink no-underline">NEBULA <b>FRONTIER</b></Link>
          <h1 className="nf-h1 text-[40px]">{mode === "register" ? "Enlist, pilot." : "Welcome back, pilot."}</h1>
          <p className="m-0 max-w-md text-[15px] leading-relaxed text-dim">
            Your hangar, clan and season progress are waiting. Sessions use secure httpOnly cookies — nothing sensitive is stored in your browser.
          </p>
          <ul className="m-0 grid list-none gap-2 p-0 text-[14px] text-dim">
            {["Wallet or email sign-in", "Cross-play: browser, Android & iOS", "Devnet only — no real funds"].map((x) => (
              <li key={x} className="flex items-center gap-2"><span className="text-accent"><Icon name="check" size={15} /></span>{x}</li>
            ))}
          </ul>
        </div>
        <HoloPanel cut corners glow className="w-full" title={mode === "register" ? "Create account" : "Sign in"}>
          <div className="grid gap-5">
            {DEMO_MODE && <DemoQuickStart onAuthed={onAuthed} />}
            <Tabs
              variant="pill"
              value={method}
              onChange={setMethod}
              items={[{ key: "wallet", label: "Wallet" }, { key: "email", label: "Email" }]}
              ariaLabel="Sign-in method"
            />
            {method === "wallet" ? <WalletSignIn onAuthed={onAuthed} /> : <EmailForm mode={mode} onAuthed={onAuthed} />}
            <div className="text-center text-[13px] text-dim">
              {mode === "login" ? (
                <>New to the Frontier? <Link className="nf-link" to={`/register${params.toString() ? `?${params}` : ""}`}>Create an account</Link></>
              ) : (
                <>Already enlisted? <Link className="nf-link" to={`/login${params.toString() ? `?${params}` : ""}`}>Sign in</Link></>
              )}
            </div>
          </div>
        </HoloPanel>
      </div>
    </div>
  );
}
