// One-time `initialize` of the deployed nebula_settlement program on DEVNET (never mainnet).
// Usage (from programs/): node scripts/devnet-initialize.mjs <upgrade-authority-keypair.json> <reward-signer-pubkey>
// The signer must be the program's upgrade authority (the program enforces it). Caps below are devnet test values.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const req = createRequire(new URL('../../packages/blockchain/package.json', import.meta.url));
const k = await import(req.resolve('@solana/kit'));
const RPC = 'https://api.devnet.solana.com';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const rpc = k.createSolanaRpc(RPC);
const rpcSubscriptions = k.createSolanaRpcSubscriptions('wss://api.devnet.solana.com');
if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS) throw new Error('RPC is not devnet — refusing');
const [keypairFile, rewardSignerArg] = process.argv.slice(2);
if (!keypairFile || !rewardSignerArg) throw new Error('usage: devnet-initialize.mjs <authority-keypair.json> <reward-signer-pubkey>');
const authority = await k.createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keypairFile, 'utf8'))));
const PROGRAM = k.address('DvgysAhNTnrBjGxo7qXd8QpvP1XNpJvkfXqjwzqTQohL');
const LOADER = k.address('BPFLoaderUpgradeab1e11111111111111111111111');
const enc = k.getAddressEncoder();
const [programData] = await k.getProgramDerivedAddress({ programAddress: LOADER, seeds: [enc.encode(PROGRAM)] });
const [config] = await k.getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['config'] });
const [vault] = await k.getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['vault'] });
const rewardSigner = k.address(rewardSignerArg);
const data = new Uint8Array(8 + 32 + 2 + 8 + 8 + 8);
const dv = new DataView(data.buffer);
data.set([175, 175, 109, 31, 13, 152, 155, 237], 0);
data.set(enc.encode(rewardSigner), 8);
dv.setUint16(40, 500, true); dv.setBigUint64(42, 1_000_000_000n, true); dv.setBigUint64(50, 2_000_000_000n, true); dv.setBigInt64(58, 86_400n, true);
const ix = { programAddress: PROGRAM, data, accounts: [
  { address: authority.address, role: k.AccountRole.WRITABLE_SIGNER, signer: authority },
  { address: PROGRAM, role: k.AccountRole.READONLY },
  { address: programData, role: k.AccountRole.READONLY },
  { address: config, role: k.AccountRole.WRITABLE },
  { address: vault, role: k.AccountRole.WRITABLE },
  { address: k.address('11111111111111111111111111111111'), role: k.AccountRole.READONLY },
] };
const { value: bh } = await rpc.getLatestBlockhash().send();
const msg = k.pipe(k.createTransactionMessage({ version: 0 }), (m) => k.setTransactionMessageFeePayerSigner(authority, m),
  (m) => k.setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => k.appendTransactionMessageInstruction(ix, m));
const tx = await k.signTransactionMessageWithSigners(msg);
await k.sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(tx, { commitment: 'confirmed' });
const sig = k.getSignatureFromTransaction(tx);
console.log('initialize signature', sig);
const acc = await rpc.getAccountInfo(config, { encoding: 'base64' }).send();
const buf = Buffer.from(acc.value.data[0], 'base64');
const dec = k.getAddressDecoder();
console.log('config', config, 'owner', acc.value.owner, 'len', buf.length);
console.log('config.authority == signer:', dec.decode(buf.subarray(8, 40)) === authority.address);
console.log('config.reward_signer ok:', dec.decode(buf.subarray(72, 104)) === rewardSigner, 'fee_bps', buf.readUInt16LE(104),
  'max_per_claim', buf.readBigUInt64LE(106), 'max_per_epoch', buf.readBigUInt64LE(114));
const logs = await rpc.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).send();
console.log(logs.meta.logMessages.join('\n'));
