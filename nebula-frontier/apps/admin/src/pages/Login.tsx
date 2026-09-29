import { useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HoloPanel, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";

/** Admin sign-in reuses the player cookie session; the API decides admin roles. */
export function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.login(email, password);
      qc.setQueryData(["me"], r.user);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <HoloPanel cut corners glow title="Operations console" className="w-full max-w-[420px]">
        <form className="grid gap-3" onSubmit={(e) => void submit(e)}>
          <p className="m-0 text-[13px] text-dim">Sign in with an account that holds an admin role. Wallet-only admins can sign in on the game site first — the session cookie is shared on the same domain.</p>
          <label className="grid gap-1.5"><span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">Email</span><input className="nf-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="grid gap-1.5"><span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">Password</span><input className="nf-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {err && <div className="text-[13px] text-bad">{err}</div>}
          <NeonButton type="submit" variant="primary" loading={busy}>Sign in</NeonButton>
        </form>
      </HoloPanel>
    </div>
  );
}
