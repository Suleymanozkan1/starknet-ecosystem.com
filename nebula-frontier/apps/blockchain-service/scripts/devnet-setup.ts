/**
 * Devnet bootstrap: generates (or reuses) the devnet treasury keypair and a test "player" wallet,
 * stores them under .secrets/ (gitignored, mode 600), writes TREASURY_PUBLIC_KEY/TREASURY_SECRET to
 * the local .env (gitignored) and requests faucet airdrops with retries.
 *
 *   pnpm --filter @nebula/blockchain-service devnet:setup
 *   (or: npx tsx scripts/devnet-setup.ts from repo root)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import { createRpcFromEnv, exportKeyPairBytes, getSolanaNetwork, explorerUrl, type SolanaRpcClient } from "@nebula/blockchain";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRETS = resolve(ROOT, ".secrets");
const ENV_FILE = resolve(ROOT, ".env");

export async function loadOrCreateKeypair(file: string): Promise<{ address: Address; bytes: Uint8Array; created: boolean }> {
  if (existsSync(file)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    return { address: signer.address, bytes, created: false };
  }
  const signer = await generateKeyPairSigner(true);
  const bytes = await exportKeyPairBytes(signer.keyPair);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(Array.from(bytes)), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { address: signer.address, bytes, created: true };
}

export function upsertEnv(vars: Record<string, string>, file = ENV_FILE): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(vars)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${k}=${v}`, "");
    }
  }
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function airdropWithRetry(rpc: SolanaRpcClient, addr: Address, target: bigint, attempts = 6): Promise<{ balance: bigint; signatures: string[]; errors: string[] }> {
  const signatures: string[] = [];
  const errors: string[] = [];
  let balance = (await rpc.getBalance(addr, { commitment: "confirmed" }).send()).value;
  const amounts = [2_000_000_000n, 1_000_000_000n, 1_000_000_000n, 500_000_000n];
  for (let i = 0; i < attempts && balance < target; i++) {
    const amt = amounts[Math.min(i, amounts.length - 1)] ?? 1_000_000_000n;
    try {
      const sig = await rpc.requestAirdrop(addr, lamports(amt), { commitment: "confirmed" }).send();
      signatures.push(sig);
      for (let j = 0; j < 30; j++) {
        await sleep(1000);
        const st = await rpc.getSignatureStatuses([sig]).send();
        const s = st.value[0];
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) break;
      }
    } catch (err) {
      errors.push((err as Error).message.slice(0, 200));
      await sleep(3000 * (i + 1));
    }
    balance = (await rpc.getBalance(addr, { commitment: "confirmed" }).send()).value;
  }
  return { balance, signatures, errors };
}

export async function main(): Promise<void> {
  const network = getSolanaNetwork();
  if (network !== "devnet" && network !== "localnet") throw new Error("devnet-setup only runs on devnet/localnet");
  const rpc = createRpcFromEnv();
  const treasury = await loadOrCreateKeypair(resolve(SECRETS, "treasury-devnet.json"));
  const player = await loadOrCreateKeypair(resolve(SECRETS, "player-devnet.json"));
  console.info(`Treasury public key: ${treasury.address}${treasury.created ? " (new)" : " (existing)"}`);
  console.info(`Test player wallet:  ${player.address}${player.created ? " (new)" : " (existing)"}`);

  // Secret goes to the gitignored .env only — never printed.
  upsertEnv({ TREASURY_PUBLIC_KEY: treasury.address, TREASURY_SECRET: JSON.stringify(Array.from(treasury.bytes)) });
  console.info(".env updated with TREASURY_PUBLIC_KEY and TREASURY_SECRET (value not shown)");

  const t = await airdropWithRetry(rpc, treasury.address, 1_000_000_000n);
  console.info(`Treasury balance: ${t.balance} lamports; airdrops: ${t.signatures.length}; errors: ${t.errors.length}`);
  for (const s of t.signatures) console.info(`  airdrop ${explorerUrl(s, network)}`);
  for (const e of t.errors) console.warn(`  faucet error: ${e}`);
  const p = await airdropWithRetry(rpc, player.address, 200_000_000n, 3);
  console.info(`Player balance: ${p.balance} lamports; airdrops: ${p.signatures.length}; errors: ${p.errors.length}`);
  for (const e of p.errors) console.warn(`  faucet error: ${e}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
