# Reference repository inspection notes

Raw findings from inspecting `tools/reference-repos/*` (see `docs/REPOSITORIES.md` for the final integration table).

## Licenses / versions
| Repo | License | Packages |
|---|---|---|
| colyseus | MIT | `colyseus` 0.18.8, `@colyseus/core` 0.18.17, `@colyseus/sdk` 0.18.4, `@colyseus/testing` 0.18.6, `@colyseus/ws-transport`, `@colyseus/redis-presence` 0.18.5, `@colyseus/redis-driver`; core requires `@colyseus/schema` ^5 |
| phaser | MIT | `phaser` 4.2.1 |
| tutorial-phaser | README: MIT (assets CC0) | Colyseus 0.17-era tutorial |
| tosios | MIT | Colyseus 0.14, pixi (architecture reference only) |
| io-template | ISC (package.json) | Colyseus 0.9 — obsolete, architecture reference only |
| kit | MIT | `@solana/kit` 8.4.0 |
| wallet-adapter | Apache-2.0 | `@solana/wallet-adapter-react` 0.15.40, `-react-ui` 0.9.40, `-phantom`, `-solflare` |
| mpl-token-metadata | Metaplex NFT Open Source License v1.0 (not OSI) | `@metaplex-foundation/mpl-token-metadata` 3.4.0 (Umi), `-kit` 0.0.3 (early) |
| anchor | Apache-2.0 | anchor-lang 1.2.0, TS client renamed `@anchor-lang/core` |
| prisma | Apache-2.0 | main = 8.0 RC (TS contract); stable 7.10 used here |

## Colyseus 0.18
- `import { defineServer, defineRoom, Room, Client, matchMaker, validate } from "colyseus"`; `WebSocketTransport` from `@colyseus/ws-transport`; `RedisPresence`, `RedisDriver`.
- `defineServer({ presence, driver, transport, rooms: { sector: defineRoom(SectorRoom).filterBy(["mapId"]) } })`; `server.listen(port)`. Legacy `new Server({transport})` + `server.define()` still works.
- Room generic: `Room<{ state: S; metadata: M; client: Client<{ userData; auth; messages }> }>`; `state = new State()` as field; hooks `onCreate, onAuth, onJoin, onLeave, onDrop, onReconnect, onDispose, onBeforePatch`.
- Messages: `messages = { move: validate(zodSchema, function (client, msg) {...}) }` or `this.onMessage(type, cb)`.
- `setSimulationInterval(cb, ms)`, `setPatchRate(ms)`, `setFixedTimestep((ctx)=>..., hz)`, `defineInput(Schema, { bufferMaxSize, sanitize })`, `allowRewindState({ maxRewindMs })` (see `colyseus/PREDICTION.md`).
- Schema v5: decorator style `class P extends Schema { @type("number") x: number }` or builder `schema({ x: t.number() })`. Interest management with `StateView` + `@view()`; `client.view = new StateView(); view.add(entity)`.
- Testing: `import { boot } from "@colyseus/testing"; const colyseus = await boot(appConfig); const room = await colyseus.createRoom("x", {}); const client = await colyseus.connectTo(room); await room.waitForNextPatch();`
- Client: `import { Client, Callbacks } from "@colyseus/sdk"; const cb = Callbacks.get(room); cb.onAdd("players", (p, id)=>...); cb.onChange(p, ()=>...)`; prediction helpers `@colyseus/sdk/predict`.

## tutorial-phaser (netcode steps)
1. render server state; 2. send input each frame; 3. local prediction + lerp remote; 4. fixed tick on both sides with `tick` ack, server `inputQueue` drained in `fixedTick`. No reconciliation (added by core's reconciler).

## tosios (architecture)
- `common` package with pure movement/collision functions shared by client & server; server Schema entities; client managers with pooled sprites keyed by id.
- Room: `onCreate` → metadata + state; `setSimulationInterval(state.update)`; message whitelist → action queue; reconciliation via `ack` timestamp: drop acked inputs, replay rest with shared `movePlayer`, snap on mismatch; remotes lerp to `toX/toY`.

## @solana/kit 8.4
`createSolanaRpc`, `createSolanaRpcSubscriptions`, `createKeyPairSignerFromBytes(64 bytes)`, `generateKeyPairSigner`, `pipe(createTransactionMessage({version:0}), m=>setTransactionMessageFeePayerSigner(signer,m), m=>setTransactionMessageLifetimeUsingBlockhash(bh,m), m=>appendTransactionMessageInstruction(ix,m))`, `signTransactionMessageWithSigners`, `getSignatureFromTransaction`, `sendAndConfirmTransactionFactory({rpc, rpcSubscriptions})(tx,{commitment:"confirmed"})`, `address()`, `lamports()`, `signature()`, `getPublicKeyFromAddress`, `verifySignature(key, sigBytes, data)`, `getBase58Encoder()`, `getUtf8Encoder()`. `@solana-program/system` `getTransferSolInstruction({ source, destination, amount })`.

## wallet-adapter
`ConnectionProvider`, `WalletProvider` (auto-detects Wallet Standard wallets incl. Backpack), `WalletModalProvider`, `WalletMultiButton`, `useWallet().signMessage(bytes)`, `sendTransaction`. Depends on `@solana/web3.js` 1.x.

## Metaplex / Anchor
- NFT: Umi `createNft(umi, { mint, name, uri, sellerFeeBasisPoints })`; kit client `createNft` returns `[createIx, mintIx]`.
- Anchor 1.2: `declare_id!`, `#[program]`, `#[derive(Accounts)]`, TS `@anchor-lang/core`.

## Prisma 7
`generator client { provider = "prisma-client"; output = ... }`, `prisma.config.ts` with `defineConfig` from `prisma/config`, driver adapter `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
