/**
 * Static demo build (e.g. a Vercel preview without backend services). When enabled, REST calls are answered
 * by the in-browser mock in ../demo/mockApi.ts and the game client runs an offline simulation. Nothing in
 * demo mode touches real accounts, balances or the blockchain.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
