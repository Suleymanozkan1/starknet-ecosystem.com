/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin for native builds (Capacitor). Empty => same-origin `/api` (dev proxy / reverse proxy). */
  readonly VITE_API_URL?: string;
  /** Solana devnet RPC endpoint for the wallet adapter connection. */
  readonly VITE_SOLANA_RPC_URL?: string;
  /** Comma separated https hosts accepted for deep links / universal links. */
  readonly VITE_DEEP_LINK_HOSTS?: string;
  /** Public web origin used for share links. */
  readonly VITE_PUBLIC_WEB_URL?: string;
  /** "true" => static demo build: REST is served by an in-browser mock and the game runs a local simulation. */
  readonly VITE_DEMO_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
