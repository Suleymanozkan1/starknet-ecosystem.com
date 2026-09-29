import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./wallet-theme.css";
import { toast } from "../store/ui.js";
import { tNow } from "../lib/i18n.js";

export const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || "https://api.devnet.solana.com";

/**
 * Solana wallet context (devnet). Phantom and Solflare legacy adapters are registered explicitly;
 * every Wallet Standard wallet (Backpack, Phantom/Solflare standard builds, mobile wallet adapter)
 * is detected automatically by WalletProvider.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet })], []);
  const onError = useCallback((error: WalletError, adapter?: Adapter) => {
    // User rejections are expected; everything else is surfaced.
    if (/reject|cancel/i.test(error.message || error.name)) return;
    toast.error(adapter ? tNow("wallet.adapterError", { name: adapter.name }) : tNow("wallet.error"), error.message || error.name);
  }, []);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** Route layout that mounts the wallet providers only for routes that need them (keeps web3.js out of the main chunk). */
export default function WalletLayout() {
  return (
    <WalletProviders>
      <Outlet />
    </WalletProviders>
  );
}
