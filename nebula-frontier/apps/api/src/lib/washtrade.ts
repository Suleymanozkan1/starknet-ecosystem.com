/**
 * Wash-trade / multi-account relationship detection between two users (buyer & seller, bidder &
 * seller). Signals: shared client device id, shared public IP (recent), wallet cross-links
 * (deposit source or withdrawal destination owned by the other account).
 */
import type { DbOrTx } from "@nebula/database";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const WINDOW_MS = 30 * 86_400_000;

export async function relationshipSignals(db: DbOrTx, a: string, b: string): Promise<string[]> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [devA, devB, sessA, sessB, walletsA, walletsB] = await Promise.all([
    db.device.findMany({ where: { userId: a }, select: { fingerprint: true, ip: true } }),
    db.device.findMany({ where: { userId: b }, select: { fingerprint: true, ip: true } }),
    db.session.findMany({ where: { userId: a, createdAt: { gte: since } }, select: { ip: true }, take: 200 }),
    db.session.findMany({ where: { userId: b, createdAt: { gte: since } }, select: { ip: true }, take: 200 }),
    db.wallet.findMany({ where: { userId: a }, select: { address: true } }),
    db.wallet.findMany({ where: { userId: b }, select: { address: true } }),
  ]);
  const reasons: string[] = [];
  // Only explicit client device ids count; user-agent hashes are shared by many real users.
  const fpA = new Set(devA.map((d) => d.fingerprint).filter((f) => f.startsWith("d:")));
  if (devB.some((d) => fpA.has(d.fingerprint))) reasons.push("SHARED_DEVICE");

  const ips = (rows: { ip: string | null }[]) => new Set(rows.map((r) => r.ip).filter((ip): ip is string => Boolean(ip) && !LOOPBACK.has(ip as string)));
  const ipA = ips([...devA, ...sessA]);
  if ([...ips([...devB, ...sessB])].some((ip) => ipA.has(ip))) reasons.push("SHARED_IP");

  const addrA = walletsA.map((w) => w.address);
  const addrB = walletsB.map((w) => w.address);
  if (addrA.length || addrB.length) {
    const [depCross, wdCross] = await Promise.all([
      db.deposit.count({
        where: { OR: [{ userId: a, walletAddress: { in: addrB } }, { userId: b, walletAddress: { in: addrA } }] },
      }),
      db.withdrawal.count({
        where: { OR: [{ userId: a, address: { in: addrB } }, { userId: b, address: { in: addrA } }] },
      }),
    ]);
    if (depCross > 0 || wdCross > 0) reasons.push("WALLET_CLUSTER");
  }
  return reasons;
}
