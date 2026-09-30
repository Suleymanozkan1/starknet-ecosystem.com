/**
 * Devnet NFT mint (feature-flagged): mints one Metaplex NonFungible for an nftEligible item.
 * Requires NFT_MINTING_ENABLED=true and a funded treasury. Metadata JSON is printed (host it and pass
 * --uri, otherwise a placeholder data URI host is used).
 *
 *   NFT_MINTING_ENABLED=true SERVICE_ROLE=blockchain npx tsx scripts/mint-devnet-nft.ts --item ship_x --owner <addr> [--uri https://...] [--out meta.json] [--dry-run]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ITEMS, SHIPS } from "@nebula/config";
import { solanaAddressSchema } from "@nebula/validation";
import {
  assertNftEligible,
  assertRpcCluster,
  buildNftMetadataJson,
  createRpcFromEnv,
  explorerUrl,
  getSolanaNetwork,
  isNftMintingEnabled,
  loadTreasurySigner,
  mintNft,
  NftFamily
} from "@nebula/blockchain";

/** CLI input is external: the owner must be a Solana address and the metadata/image URIs http(s). */
export const mintArgsSchema = z.object({
  owner: solanaAddressSchema,
  uri: z.url({ protocol: /^https?$/ }),
  image: z.url({ protocol: /^https?$/ })
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  if (!isNftMintingEnabled()) throw new Error("NFT minting is disabled. Set NFT_MINTING_ENABLED=true (devnet only).");
  const itemId = arg("item");
  // Fall back to the first NFT-eligible ship only when --item is absent; never mint a substitute.
  const ship = itemId !== undefined ? SHIPS.find((s) => s.id === itemId) : SHIPS.find((s) => s.nftEligible);
  const item = itemId !== undefined ? (ITEMS.find((i) => i.id === itemId) ?? null) : null;
  const def = item ?? ship;
  if (!def) throw new Error(itemId !== undefined ? `Unknown item ${itemId}` : "No NFT-eligible item found");
  assertNftEligible({ id: def.id, name: def.name, nftEligible: def.nftEligible });
  const signer = await loadTreasurySigner();
  const webUrl = process.env.PUBLIC_WEB_URL ?? "http://localhost:5173";
  const parsed = mintArgsSchema.safeParse({
    owner: arg("owner") ?? signer.address,
    uri: arg("uri") ?? `${webUrl}/nft/${def.id}.json`,
    image: arg("image") ?? `${webUrl}/nft/${def.id}.png`
  });
  if (!parsed.success) throw new Error(`Invalid mint arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const { owner, uri, image } = parsed.data;
  const family = ship && def === ship ? NftFamily.LEGENDARY_SHIP : item?.category === "SKIN" ? NftFamily.LIMITED_SKIN : NftFamily.FOUNDER_COSMETIC;
  const json = buildNftMetadataJson({
    family,
    itemId: def.id,
    name: def.name.slice(0, 24),
    description: `NEBULA FRONTIER ${family.replace(/_/g, " ").toLowerCase()} — cosmetic ownership record (devnet).`,
    image,
    rarity: "rarity" in def ? String(def.rarity) : "LEGENDARY",
    shipClass: ship && def === ship ? ship.class : null,
    faction: null,
    edition: { number: 1, max: 100 }
  });
  console.info("Metadata JSON (host this at --uri):");
  console.info(JSON.stringify(json, null, 2));
  // --dry-run --out <file>: only write the metadata JSON (to publish it at --uri before minting).
  const out = arg("out");
  if (out) writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
  if (process.argv.includes("--dry-run")) return;
  const rpc = createRpcFromEnv();
  // Never submit a treasury-funded mint to an unintended cluster.
  await assertRpcCluster(rpc);
  const { mint, outcome } = await mintNft(rpc, { payer: signer, owner, name: json.name, symbol: json.symbol, uri });
  console.info(`Mint: ${mint}  status: ${outcome.status}`);
  console.info(`Tx: ${explorerUrl(outcome.signature, getSolanaNetwork())}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
