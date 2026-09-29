# Static demo build (Vercel)

The Vercel deployment serves the web app as a **self-contained demo**. It needs no API, game server, database, Redis or Solana RPC.

## How it works

The build sets `VITE_DEMO_MODE=true` (see `/vercel.json`). This changes three things:

1. **REST calls** in `apps/web/src/lib/http.ts` go to `apps/web/src/demo/mockApi.ts`.
   - This in-browser mock returns the same shapes as `apps/api`.
   - It uses the real game data and rules from `@nebula/config` and `@nebula/game-core`.
   - State is kept in `localStorage`, so each browser has its own demo pilot.
2. **The game ticket** points to `local://demo`.
   - `GameSession` (`packages/game-network/src/session.ts`) then uses `LocalConnection` instead of Colyseus.
   - `LocalConnection` runs `LocalWorld` (`packages/game-network/src/local/world.ts`) at 20 Hz in the browser.
   - `LocalWorld` uses the same rules as the authoritative server: `stepShip` movement, `tryFire`/`resolveHit` combat, NPC brains, boss phases, abilities, mining, loot, XP, docking and portal jumps.
3. **Rewards and loot from the simulation** are copied into the local demo account.
   - Credits, XP, resources and items show up in the hangar, inventory and profile screens.

## What is disabled in the demo

- **Wallet sign-in, deposits, withdrawals and anything on-chain** return `DEMO_DISABLED`.
- **Other players:** multiplayer, PvP, chat and friends run solo or show synthetic data.
- **Nothing is real:** no real accounts, balances or assets exist. A "Demo" badge is shown on every screen except gameplay, and gameplay shows a demo notice on join.
- **Portal level requirements** are shown but not enforced, so every sector can be explored.

## Running it locally

```bash
cd nebula-frontier
VITE_DEMO_MODE=true pnpm --filter @nebula/web dev     # or: build && preview
```

## Full stack

Build without `VITE_DEMO_MODE` to use the full stack: API, game server and blockchain service. See `docs/DEPLOYMENT.md`.
