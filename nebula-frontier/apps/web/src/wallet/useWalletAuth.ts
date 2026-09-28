import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import type { MeResponse } from "@nebula/shared";
import { api } from "../lib/api.js";
import { getDeviceId } from "../native/secureStorage.js";

type Purpose = "LOGIN" | "LINK_WALLET";
type Phase = "idle" | "connecting" | "nonce" | "signing" | "verifying" | "done" | "error";

/**
 * Sign-in with wallet:
 *   POST /api/auth/nonce {address} → { nonce, message }
 *   wallet.signMessage(utf8(message))                       (ed25519 over the exact server message)
 *   POST /api/auth/verify {address, nonce, signature: bs58} → httpOnly session cookies
 * For LINK_WALLET the signature goes to POST /api/wallet/connect instead (links it to the signed-in account).
 * If no wallet is connected yet the wallet modal opens and signing resumes once connected.
 */
export function useWalletAuth(onDone: (user: MeResponse | null) => void) {
  const { publicKey, signMessage, connected, wallet, disconnect } = useWallet();
  const { setVisible, visible } = useWalletModal();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const pendingPurpose = useRef<Purpose | null>(null);
  const running = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const run = useCallback(async (purpose: Purpose) => {
    if (running.current || !publicKey) return;
    running.current = true;
    setError(null);
    try {
      if (!signMessage) throw new Error(`${wallet?.adapter.name ?? "This wallet"} does not support message signing.`);
      const address = publicKey.toBase58();
      setPhase("nonce");
      const { nonce, message } = await api.auth.nonce({ address, purpose });
      setPhase("signing");
      const signatureBytes = await signMessage(new TextEncoder().encode(message));
      const signature = bs58.encode(signatureBytes);
      setPhase("verifying");
      if (purpose === "LOGIN") {
        const deviceId = await getDeviceId();
        const res = await api.auth.verify({ address, nonce, signature, deviceId });
        setPhase("done");
        onDoneRef.current(res.user);
      } else {
        await api.wallet.connect({ address, nonce, signature });
        setPhase("done");
        onDoneRef.current(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/reject|declin|cancel/i.test(msg) ? "Signature request was rejected in the wallet." : msg);
      setPhase("error");
    } finally {
      running.current = false;
      pendingPurpose.current = null;
    }
  }, [publicKey, signMessage, wallet]);

  const start = useCallback((purpose: Purpose = "LOGIN") => {
    setError(null);
    if (connected && publicKey) {
      void run(purpose);
      return;
    }
    pendingPurpose.current = purpose;
    setPhase("connecting");
    setVisible(true);
  }, [connected, publicKey, run, setVisible]);

  // Resume after the wallet modal connected a wallet.
  useEffect(() => {
    if (connected && publicKey && pendingPurpose.current) void run(pendingPurpose.current);
  }, [connected, publicKey, run]);

  // Modal closed without connecting.
  useEffect(() => {
    if (!visible && phase === "connecting" && !connected) {
      const t = window.setTimeout(() => {
        if (!pendingPurpose.current) return;
        pendingPurpose.current = null;
        setPhase("idle");
      }, 400);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [visible, phase, connected]);

  return {
    start,
    phase,
    error,
    busy: phase === "nonce" || phase === "signing" || phase === "verifying" || phase === "connecting",
    address: publicKey?.toBase58() ?? null,
    walletName: wallet?.adapter.name ?? null,
    walletIcon: wallet?.adapter.icon ?? null,
    disconnect,
  };
}
