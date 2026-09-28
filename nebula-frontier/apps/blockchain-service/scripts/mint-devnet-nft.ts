/**
 * Devnet NFT mint (feature-flagged): mints one Metaplex NonFungible for an nftEligible item.
 * Requires NFT_MINTING_ENABLED=true and a funded treasury. Metadata JSON is printed (host it and pass
 * --uri, otherwise a placeholder data URI host is used).
 *
 *   NFT_MINTING_ENABLED=true SERVICE_ROLE=blockchain npx tsx scripts/mint-devnet-nft.ts --item ship_x --owner <addr> [--uri https://...]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS, SHIPS } from "@nebula/config";
import {
  assertNftEligible,
  buildNftMetadataJson,
  createRpcFromEnv,
  explorerUrl,
  getSolanaNetwork,
  isNftMintingEnabled,
  loadTreasurySigner,
  mintNft,
  NftFamily
} from "@nebula/blockchain";

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
  const owner = arg("owner") ?? signer.address;
  const family = ship && def === ship ? NftFamily.LEGENDARY_SHIP : item?.category === "SKIN" ? NftFamily.LIMITED_SKIN : NftFamily.FOUNDER_COSMETIC;
  const json = buildNftMetadataJson({
    family,
    itemId: def.id,
    name: def.name.slice(0, 24),
    description: `NEBULA FRONTIER ${family.replace(/_/g, " ").toLowerCase()} — cosmetic ownership record (devnet).`,
    image: arg("image") ?? `${process.env.PUBLIC_WEB_URL ?? "http://localhost:5173"}/nft/${def.id}.png`,
    rarity: "rarity" in def ? String(def.rarity) : "LEGENDARY",
    shipClass: ship && def === ship ? ship.class : null,
    faction: null,
    edition: { number: 1, max: 100 }
  });
  console.info("Metadata JSON (host this at --uri):");
  console.info(JSON.stringify(json, null, 2));
  const uri = arg("uri") ?? `${process.env.PUBLIC_WEB_URL ?? "http://localhost:5173"}/nft/${def.id}.json`;
  const rpc = createRpcFromEnv();
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
