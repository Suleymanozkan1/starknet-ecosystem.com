import {
  address as toAddress,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner
} from "@solana/kit";
// Loaded lazily so processes that never mint (API, game server) don't load the Metaplex client.
const metaplex = () => import("@metaplex-foundation/mpl-token-metadata-kit");
import type { SolanaRpcClient } from "./rpc.js";
import { waitForConfirmation, type ConfirmationOutcome } from "./transfer.js";

/**
 * NFT architecture (devnet, feature-flagged).
 *
 * Only items whose definition has `nftEligible: true` can become NFTs, and only for the three
 * cosmetic/prestige families below. Power items are never NFTs (no pay-to-win on chain).
 *   - LEGENDARY_SHIP  : legendary ship hulls (cosmetic ownership proof; stats stay server-side)
 *   - LIMITED_SKIN    : limited-edition skins with a fixed edition count
 *   - FOUNDER_COSMETIC: founder badges/trails for early supporters
 * Minting is disabled unless NFT_MINTING_ENABLED=true (and the API additionally checks the
 * `nft_minting` FeatureFlag row).
 */
export const NftFamily = {
  LEGENDARY_SHIP: "LEGENDARY_SHIP",
  LIMITED_SKIN: "LIMITED_SKIN",
  FOUNDER_COSMETIC: "FOUNDER_COSMETIC"
} as const;
export type NftFamily = (typeof NftFamily)[keyof typeof NftFamily];

export interface NftEligibleItem {
  id: string;
  name: string;
  nftEligible: boolean;
  rarity?: string;
  category?: string;
}

export interface NftMetadataInput {
  family: NftFamily;
  itemId: string;
  name: string;
  symbol?: string;
  description: string;
  image: string;
  externalUrl?: string;
  rarity: string;
  shipClass?: string | null;
  faction?: string | null;
  edition?: { number: number; max: number } | null;
  extraAttributes?: Record<string, string | number>;
}

export interface MetaplexJsonMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: { trait_type: string; value: string | number }[];
  properties: { category: "image"; files: { uri: string; type: string }[] };
}

export function isNftMintingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NFT_MINTING_ENABLED === "true";
}

export function assertNftEligible(item: NftEligibleItem): void {
  if (!item.nftEligible) throw new Error(`Item ${item.id} is not NFT eligible`);
}

/** Builds the off-chain JSON (Metaplex Token Metadata standard) the on-chain `uri` points to. */
export function buildNftMetadataJson(input: NftMetadataInput): MetaplexJsonMetadata {
  const name = input.edition ? `${input.name} #${input.edition.number}` : input.name;
  if (Buffer.byteLength(name, "utf8") > 32) throw new Error("NFT name exceeds 32 bytes (Metaplex limit)");
  const symbol = input.symbol ?? "NEBF";
  if (Buffer.byteLength(symbol, "utf8") > 10) throw new Error("NFT symbol exceeds 10 bytes");
  const attributes: { trait_type: string; value: string | number }[] = [
    { trait_type: "Family", value: input.family },
    { trait_type: "Item", value: input.itemId },
    { trait_type: "Rarity", value: input.rarity }
  ];
  if (input.shipClass) attributes.push({ trait_type: "Ship Class", value: input.shipClass });
  if (input.faction) attributes.push({ trait_type: "Faction", value: input.faction });
  if (input.edition) {
    attributes.push({ trait_type: "Edition", value: input.edition.number });
    attributes.push({ trait_type: "Max Edition", value: input.edition.max });
  }
  for (const [k, v] of Object.entries(input.extraAttributes ?? {})) attributes.push({ trait_type: k, value: v });
  const ext = input.image.split("?")[0]?.split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
  return {
    name,
    symbol,
    description: input.description,
    image: input.image,
    ...(input.externalUrl ? { external_url: input.externalUrl } : {}),
    attributes,
    properties: { category: "image", files: [{ uri: input.image, type: mime }] }
  };
}

export interface MintNftInstructionsInput {
  payer: TransactionSigner;
  /** Fresh mint keypair signer. */
  mint: KeyPairSigner;
  owner: string;
  name: string;
  symbol?: string;
  uri: string;
  sellerFeeBasisPoints?: number;
}

/** [createV1, mintV1] instructions via the Metaplex kit client (NonFungible, supply 1). */
export async function buildMintNftInstructions(input: MintNftInstructionsInput): Promise<Instruction[]> {
  if (Buffer.byteLength(input.uri, "utf8") > 200) throw new Error("NFT uri exceeds 200 bytes");
  const { createNft } = await metaplex();
  const [createIx, mintIx] = await createNft({
    mint: input.mint,
    authority: input.payer,
    payer: input.payer,
    name: input.name,
    symbol: input.symbol ?? "NEBF",
    uri: input.uri,
    sellerFeeBasisPoints: input.sellerFeeBasisPoints ?? 0,
    tokenOwner: toAddress(input.owner)
  } as Parameters<typeof createNft>[0]);
  return [createIx as Instruction, mintIx as Instruction];
}

export async function getMetadataAddress(mint: string): Promise<string> {
  const { findMetadataPda } = await metaplex();
  const [pda] = await findMetadataPda({ mint: toAddress(mint) } as Parameters<typeof findMetadataPda>[0]);
  return pda;
}

/** Mints one NFT on devnet. Throws unless NFT_MINTING_ENABLED=true. */
export async function mintNft(
  rpc: SolanaRpcClient,
  input: Omit<MintNftInstructionsInput, "mint"> & { mint?: KeyPairSigner }
): Promise<{ mint: string; outcome: ConfirmationOutcome }> {
  if (!isNftMintingEnabled()) throw new Error("NFT minting is disabled (set NFT_MINTING_ENABLED=true)");
  const mint = input.mint ?? (await generateKeyPairSigner());
  const ixs = await buildMintNftInstructions({ ...input, mint });
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m)
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const outcome = await waitForConfirmation(rpc, sig, bh.lastValidBlockHeight, { timeoutMs: 90_000 });
  return { mint: mint.address, outcome };
}
