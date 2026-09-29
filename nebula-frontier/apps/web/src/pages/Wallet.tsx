import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Countdown, CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, StatBar, Tabs, formatAmount } from "@nebula/game-ui";
import { formatUnits, parseUnits } from "@nebula/shared";
import type { DepositDto, WalletResponse, WithdrawalDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import type { DepositVerifyResponse, WithdrawQuoteResponse } from "../lib/dto.js";
import { errorMessage, idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useEconomyStatus, useRewards, useShop, useTransactions, useWallet } from "../lib/queries.js";
import { relTime, shortAddr } from "../lib/gameMeta.js";
import { Rich, enumLabel, fmtDecimalStr, fmtFixed, productName, tNow, translateServerText, useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { FeeRow } from "./Market.js";
import { explorerAddressUrl, explorerTxUrl, sendDeposit } from "../wallet/deposit.js";
import { useWalletAuth } from "../wallet/useWalletAuth.js";
import { copyText } from "../native/clipboard.js";
import { biometricGate } from "../native/biometric.js";
import { haptic } from "../native/haptics.js";
import { toast } from "../store/ui.js";

const SOL_DECIMALS = 9;
const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "var(--nf-good)", CREDITED: "var(--nf-good)", CONFIRMED: "var(--nf-good)",
  PENDING: "var(--nf-warn)", PENDING_REVIEW: "var(--nf-warn)", PROCESSING: "var(--nf-accent)", SUBMITTED: "var(--nf-accent)", PREPARED: "var(--nf-text-dim)",
  FAILED: "var(--nf-bad)", REJECTED: "var(--nf-bad)", CANCELLED: "var(--nf-text-mute)", EXPIRED: "var(--nf-text-mute)",
};

function StatusChip({ s }: { s: string }) {
  return <span className="nf-chip text-[10.5px]" style={{ color: STATUS_COLOR[s] ?? "var(--nf-text-dim)", borderColor: `color-mix(in oklab, ${STATUS_COLOR[s] ?? "var(--nf-line)"} 50%, transparent)` }}>{enumLabel(s)}</span>;
}

/** Localised plain decimal (base-unit formatted amounts such as limits and fees). */
function units(v: string | bigint, dec: number): string {
  return fmtDecimalStr(formatUnits(v, dec));
}

function Sig({ sig }: { sig: string | null }) {
  const t = useT();
  if (!sig) return <span className="text-mute">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <a href={explorerTxUrl(sig)} target="_blank" rel="noreferrer noopener" className="nf-mono nf-link">{shortAddr(sig, 6)}</a>
      <button type="button" className="text-mute hover:text-ink" aria-label={t("wallet.copySig")} onClick={() => void copyText(sig).then((ok) => ok && toast.info(tNow("wallet.sigCopied")))}><Icon name="copy" size={13} /></button>
    </span>
  );
}

/* ------------------------------------------------------------------ connection / linking */
function WalletConnection({ w }: { w: WalletResponse }) {
  const t = useT();
  const qc = useQueryClient();
  const sol = useSolanaWallet();
  const modal = useWalletModal();
  const link = useWalletAuth(() => {
    toast.success(tNow("wallet.linked"), tNow("wallet.linkedBody"));
    void qc.invalidateQueries({ queryKey: qk.wallet });
    void qc.invalidateQueries({ queryKey: qk.me });
  });
  const connected = sol.publicKey?.toBase58() ?? null;
  const linked = connected ? w.wallets.some((x) => x.address === connected) : false;
  return (
    <HoloPanel title={t("wallet.wallets")} actions={<span className="nf-chip" style={{ color: /devnet/i.test(w.network) ? "var(--nf-good)" : "var(--nf-bad)" }}><Icon name="signal" size={12} />{w.network}</span>}>
      <div className="grid gap-3">
        {w.wallets.length === 0 && <div className="text-[13px] text-mute">{t("wallet.noneLinked")}</div>}
        {w.wallets.map((x) => (
          <div key={x.address} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-black/25 px-3 py-2">
            <Icon name="wallet" size={16} />
            <a className="nf-mono nf-link" href={explorerAddressUrl(x.address)} target="_blank" rel="noreferrer noopener">{shortAddr(x.address, 6)}</a>
            <button type="button" className="text-mute hover:text-ink" aria-label={t("wallet.copyAddr")} onClick={() => void copyText(x.address).then((ok) => ok && toast.info(tNow("wallet.addrCopied")))}><Icon name="copy" size={14} /></button>
            {x.primary && <span className="nf-chip text-[10px]">{t("wallet.primary")}</span>}
            {connected === x.address && <span className="nf-chip text-[10px]" style={{ color: "var(--nf-good)" }}>{t("wallet.connected")}</span>}
            <span className="ml-auto text-[11px] text-mute">{t("wallet.verified", { when: relTime(x.verifiedAt) })}</span>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <>
              <span className="text-[13px] text-dim">{sol.wallet?.adapter.name}: <span className="nf-mono">{shortAddr(connected, 5)}</span></span>
              {!linked && <NeonButton size="sm" variant="primary" loading={link.busy} onClick={() => link.start("LINK_WALLET")}>{t("wallet.linkThis")}</NeonButton>}
              <NeonButton size="sm" variant="ghost" onClick={() => void sol.disconnect()}>{t("wallet.disconnect")}</NeonButton>
            </>
          ) : (
            <NeonButton size="sm" variant="primary" onClick={() => modal.setVisible(true)} icon={<Icon name="wallet" size={14} />}>{t("wallet.connect")}</NeonButton>
          )}
        </div>
        {link.error && <div className="text-[12.5px] text-bad">{translateServerText(link.error)}</div>}
      </div>
    </HoloPanel>
  );
}

/* ------------------------------------------------------------------ rewards */
function RewardsPanel({ w }: { w: WalletResponse }) {
  const t = useT();
  const rewards = useRewards();
  const eco = useEconomyStatus();
  const claim = useApiMutation(() => api.rewards.claim({ all: true }), {
    invalidate: [qk.rewards, qk.wallet, qk.me],
    success: (r) => tNow("wallet.claimedAmount", { amount: formatAmount(r.claimed.reduce((a, c) => a + BigInt(c.amount), 0n), "NEBX"), symbol: w.rewardAsset.symbol }),
    errorTitle: t("wallet.claimFailed"),
  });
  const r = rewards.data;
  const cooling = r?.nextClaimAt && new Date(r.nextClaimAt).getTime() > Date.now();
  return (
    <HoloPanel title={t("wallet.rewardsTitle", { a: t("common.battleRewards"), b: t("common.seasonRewards") })} accent="var(--nf-crypto)">
      {rewards.error ? <ErrorState error={rewards.error} onRetry={() => void rewards.refetch()} /> : !r ? <div className="nf-skeleton h-36" /> : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="nf-label">{t("wallet.claimable")}</div>
              <CurrencyAmount amount={r.claimable} currency="NEBX" symbol={w.rewardAsset.symbol} size={24} />
            </div>
            {cooling ? <span className="text-[12.5px] text-mute">{t("wallet.nextClaim")} <Countdown to={r.nextClaimAt!} className="text-[13px]" /></span>
              : <NeonButton variant="primary" color="var(--nf-crypto)" loading={claim.isPending} disabled={BigInt(r.claimable) <= 0n || !r.eligibility.eligible} onClick={() => claim.mutate(undefined)}>{t("wallet.claimToBalance")}</NeonButton>}
          </div>
          <div className="grid gap-2">
            {([["wallet.capToday", r.caps.dailyUsed, r.caps.daily], ["wallet.capWeek", r.caps.weeklyUsed, r.caps.weekly], ["wallet.capSeason", r.caps.seasonUsed, r.caps.season]] as const satisfies readonly (readonly [TKey, string, string])[]).map(([k, used, cap]) => (
              <div key={k} className="grid gap-1">
                <div className="flex justify-between text-[12px]"><span className="nf-label">{t(k)}</span><span className="tabular-nums text-dim">{formatAmount(used, "NEBX")} / {formatAmount(cap, "NEBX")}</span></div>
                <StatBar value={Number((BigInt(used) * 1000n) / (BigInt(cap) || 1n))} max={1000} showValue={false} height={4} ghost={false} color="var(--nf-crypto)" />
              </div>
            ))}
          </div>
          <div className="grid gap-1.5 rounded-lg border border-line bg-black/25 p-3 text-[12.5px]">
            <div className="flex items-center gap-2"><span className="nf-label">{t("season.eligibility")}</span>{r.eligibility.eligible ? <span className="text-good">{t("season.eligible")}</span> : <span className="text-warn">{t("wallet.notEligibleYet")}</span>}</div>
            {!r.eligibility.eligible && r.eligibility.reasons.map((x) => <div key={x} className="text-mute">• {translateServerText(x)}</div>)}
            {eco.data && (
              <div className="mt-1 grid grid-cols-2 gap-2">
                <div><span className="nf-label">{t("wallet.poolLeft")}</span><div><CurrencyAmount amount={eco.data.rewardPoolRemaining} currency="NEBX" size={13} showIcon={false} symbol={w.rewardAsset.symbol} /></div></div>
                <div><span className="nf-label">{t("wallet.treasuryHealth")}</span><div className="nf-ui font-bold">{enumLabel(eco.data.treasuryHealth)}</div></div>
                {eco.data.activeBreakers.length > 0 && <div className="col-span-2 text-warn">{t("wallet.safeguards", { list: eco.data.activeBreakers.map((x) => enumLabel(x)).join(", ") })}</div>}
              </div>
            )}
          </div>
          <details className="text-[12.5px] text-dim">
            <summary className="nf-ui cursor-pointer text-[12px] uppercase tracking-[0.16em] text-accent">{t("wallet.rules")}</summary>
            <ul className="mt-2 grid list-disc gap-1 pl-5">{r.rules.map((x) => <li key={x}>{translateServerText(x)}</li>)}</ul>
            <p className="mb-0 mt-2 text-mute">{t("wallet.rulesNote")}</p>
          </details>
          {r.rewards.length > 0 && (
            <div className="max-h-48 overflow-y-auto">
              <table className="nf-table">
                <thead><tr><th>{t("wallet.source")}</th><th>{t("common.amount")}</th><th>{t("common.status")}</th><th>{t("common.when")}</th></tr></thead>
                <tbody>{r.rewards.slice(0, 30).map((x) => <tr key={x.id}><td>{enumLabel(x.source)}<div className="text-[11px] text-mute">{translateServerText(x.reason)}</div></td><td><CurrencyAmount amount={x.amount} currency="NEBX" size={13} showIcon={false} symbol={w.rewardAsset.symbol} /></td><td><StatusChip s={x.status} /></td><td className="text-dim">{relTime(x.createdAt)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </HoloPanel>
  );
}

/* ------------------------------------------------------------------ deposit */
type DepStage = "idle" | "preparing" | "signing" | "confirming" | "verifying" | "done" | "error";
const DEP_STEPS: { key: DepStage; label: TKey }[] = [
  { key: "preparing", label: "wallet.dep.prepare" },
  { key: "signing", label: "wallet.dep.approve" },
  { key: "confirming", label: "wallet.dep.confirm" },
  { key: "verifying", label: "wallet.dep.verify" },
];

function DepositPanel({ w, productParam }: { w: WalletResponse; productParam: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { connection } = useConnection();
  const sol = useSolanaWallet();
  const modal = useWalletModal();
  const shop = useShop();
  const gemPacks = (shop.data ?? []).filter((p) => p.currency === "SOL" && (p.purchaseFlow === "DEPOSIT" || p.category === "GEMS"));
  const [purpose, setPurpose] = useState<"GEMS" | "BALANCE">(productParam ? "GEMS" : "GEMS");
  const [productId, setProductId] = useState<string>(productParam ?? "");
  const [solAmount, setSolAmount] = useState("");
  const [stage, setStage] = useState<DepStage>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ signature: string; gems?: number } | null>(null);
  useEffect(() => {
    if (!productId && gemPacks[0]) setProductId(productParam ?? gemPacks[0].id);
  }, [gemPacks, productId, productParam]);

  const primary = w.wallets.find((x) => x.primary) ?? w.wallets[0];
  const connected = sol.publicKey?.toBase58() ?? null;
  const product = gemPacks.find((p) => p.id === productId);
  let amount: bigint | null = null;
  try {
    amount = purpose === "GEMS" ? (product ? BigInt(product.price) : null) : solAmount ? parseUnits(solAmount, SOL_DECIMALS) : null;
  } catch {
    amount = null;
  }
  const busy = stage !== "idle" && stage !== "done" && stage !== "error";
  const problems: string[] = [];
  if (!w.treasuryAddress) problems.push(t("wallet.p.noTreasury"));
  if (!primary) problems.push(t("wallet.p.linkFirst"));
  else if (!connected) problems.push(t("wallet.p.connectPrimary", { addr: shortAddr(primary.address) }));
  else if (connected !== primary.address) problems.push(t("wallet.p.wrongWallet", { connected: shortAddr(connected), primary: shortAddr(primary.address) }));
  if (!/devnet/i.test(w.network)) problems.push(t("wallet.p.notDevnet"));

  const run = async (): Promise<void> => {
    if (!amount || amount <= 0n || !sol.publicKey || !sol.sendTransaction) return;
    setErr(null);
    setResult(null);
    try {
      setStage("preparing");
      const prep = await api.wallet.depositPrepare({
        amount: amount.toString(), purpose, idempotencyKey: idempotencyKey("dep"), ...(purpose === "GEMS" && product ? { productId: product.id } : {}),
      });
      const signature = await sendDeposit(connection, sol.sendTransaction, { prep, payer: sol.publicKey, expectedTreasury: w.treasuryAddress, mintDecimals: w.rewardAsset.decimals }, (s) => setStage(s));
      setStage("verifying");
      let verified: DepositVerifyResponse | null = null;
      for (let attempt = 0; attempt < 8 && !verified; attempt++) {
        const res = await api.wallet.depositVerify({ depositId: prep.depositId, signature });
        if ("deposit" in res) verified = res;
        else await new Promise((r) => setTimeout(r, 2000 + attempt * 1000));
      }
      if (!verified) throw new Error(tNow("wallet.notFinal", { sig: shortAddr(signature, 6) }));
      setStage("done");
      setResult({ signature, ...(verified.gems !== undefined ? { gems: verified.gems } : {}) });
      haptic("success");
      toast.success(tNow("wallet.depositCredited"), verified.gems ? tNow("wallet.gemsAdded", { n: verified.gems }) : tNow("wallet.solCredited"));
      await Promise.all([qc.invalidateQueries({ queryKey: qk.wallet }), qc.invalidateQueries({ queryKey: qk.me })]);
    } catch (e) {
      haptic("error");
      const m = errorMessage(e);
      setErr(/reject|declin|cancel/i.test(m) ? tNow("wallet.rejected") : m);
      setStage("error");
      void qc.invalidateQueries({ queryKey: qk.wallet });
    }
  };
  const idx = DEP_STEPS.findIndex((s) => s.key === stage);

  return (
    <HoloPanel title={t("wallet.depositTitle")} glow={busy}>
      <div className="grid gap-4">
        <Tabs variant="pill" value={purpose} onChange={(k) => !busy && setPurpose(k)} items={[{ key: "GEMS", label: t("wallet.buyGems") }, { key: "BALANCE", label: t("wallet.solBalance") }]} />
        {purpose === "GEMS" ? (
          gemPacks.length === 0 ? <div className="text-[13px] text-mute">{shop.isLoading ? t("wallet.loadingPacks") : t("wallet.noPacks")}</div> : (
            <div className="grid grid-cols-2 gap-2">
              {gemPacks.map((p) => (
                <button key={p.id} type="button" disabled={busy} onClick={() => setProductId(p.id)} className="nf-panel nf-panel--interactive grid gap-1 p-3 text-left" style={p.id === productId ? { borderColor: "var(--nf-gems)", boxShadow: "0 0 24px -8px var(--nf-gems)" } : undefined}>
                  <span className="nf-ui text-[15px] font-bold">{productName(p)}</span>
                  <CurrencyAmount amount={p.price} currency="SOL" size={14} />
                </button>
              ))}
            </div>
          )
        ) : (
          <label className="grid gap-1.5"><span className="nf-label">{t("wallet.amountSol")}</span><input className="nf-input" inputMode="decimal" value={solAmount} disabled={busy} onChange={(e) => setSolAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.10" /></label>
        )}
        {amount !== null && amount > 0n && (
          <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
            <FeeRow label={t("wallet.transfer")} amount={amount} currency="SOL" />
            <div className="flex justify-between text-[12.5px]"><span className="text-mute">{t("wallet.recipient")}</span><span className="nf-mono">{shortAddr(w.treasuryAddress, 6)}</span></div>
            <div className="text-[12px] text-mute">{t("wallet.feeNote")}</div>
          </div>
        )}
        {problems.map((p) => <div key={p} className="flex items-start gap-2 text-[12.5px] text-warn"><Icon name="warning" size={14} />{p}</div>)}
        {(busy || stage === "done") && (
          <ol className="m-0 grid list-none gap-1.5 p-0">
            {DEP_STEPS.map((s, i) => {
              const done = stage === "done" || i < idx;
              const cur = i === idx;
              return (
                <li key={s.key} className="nf-ui flex items-center gap-2 text-[13px] uppercase tracking-[0.12em]" style={{ color: done ? "var(--nf-good)" : cur ? "var(--nf-accent)" : "var(--nf-text-mute)" }}>
                  {done ? <Icon name="check" size={14} /> : cur ? <span className="nf-btn__spinner" /> : <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" />}{t(s.label)}
                </li>
              );
            })}
          </ol>
        )}
        {err && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">{translateServerText(err)}</div>}
        {result && <div className="text-[13px] text-good">{result.gems ? t("wallet.creditedGems", { n: result.gems }) : t("wallet.credited")}. <Sig sig={result.signature} /></div>}
        {!connected ? (
          <NeonButton variant="primary" onClick={() => modal.setVisible(true)} icon={<Icon name="wallet" size={16} />}>{t("wallet.connect")}</NeonButton>
        ) : (
          <NeonButton variant="primary" loading={busy} disabled={problems.length > 0 || !amount || amount <= 0n} onClick={() => void run()} data-testid="deposit-submit">
            {purpose === "GEMS" ? t("wallet.payGems") : t("wallet.depositSol")}
          </NeonButton>
        )}
      </div>
    </HoloPanel>
  );
}

/* ------------------------------------------------------------------ withdraw */
function WithdrawPanel({ w }: { w: WalletResponse }) {
  const t = useT();
  const dec = w.rewardAsset.decimals;
  const sym = w.rewardAsset.symbol;
  const [amountStr, setAmountStr] = useState("");
  const primary = w.wallets.find((x) => x.primary) ?? w.wallets[0];
  const [address, setAddress] = useState(primary?.address ?? "");
  const [quote, setQuote] = useState<WithdrawQuoteResponse | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!address && primary) setAddress(primary.address); }, [primary, address]);

  let amount: bigint | null = null;
  try {
    amount = amountStr ? parseUnits(amountStr, dec) : null;
  } catch {
    amount = null;
  }
  const amountKey = amount?.toString() ?? "";
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!amountKey || amountKey === "0") return undefined;
    // Debounced live quote: Requested / Service fee / Network fee / Final come from the server.
    const t = window.setTimeout(() => {
      api.wallet.withdrawQuote(amountKey).then(setQuote).catch((e: unknown) => setQuoteErr(errorMessage(e)));
    }, 350);
    return () => window.clearTimeout(t);
  }, [amountKey]);
  const L = quote?.limits ?? w.limits;
  const balance = BigInt(w.balances.nebx);
  const remainingDaily = BigInt(L.dailyLimit) - BigInt(L.dailyUsed);
  const issues: string[] = [];
  if (amount !== null) {
    if (amount < BigInt(L.min)) issues.push(t("wallet.i.min", { n: units(L.min, dec), sym }));
    if (amount > BigInt(L.max)) issues.push(t("wallet.i.max", { n: units(L.max, dec), sym }));
    if (amount > balance) issues.push(t("wallet.i.balance"));
    if (amount > remainingDaily) issues.push(t("wallet.i.daily"));
  }
  if (L.nextAllowedAt && new Date(L.nextAllowedAt).getTime() > Date.now()) issues.push(t("wallet.i.cooldown"));
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) issues.push(t("wallet.i.address"));
  const qc = useQueryClient();
  const withdraw = useApiMutation(async () => {
    const ok = await biometricGate(tNow("wallet.bioReason", { amount: amountStr, sym }));
    if (!ok) throw new Error(tNow("wallet.bioCancelled"));
    return api.wallet.withdraw({ amount: amount!.toString(), address, idempotencyKey: idempotencyKey("wd") });
  }, {
    errorTitle: t("wallet.withdrawFailed"),
    onSuccess: async (wd) => {
      haptic("success");
      toast.success(wd.status === "PENDING_REVIEW" ? tNow("wallet.underReview") : tNow("wallet.queued"), tNow("wallet.finalAmount", { n: units(wd.final, dec), sym }));
      setConfirm(false);
      setAmountStr("");
      await Promise.all([qc.invalidateQueries({ queryKey: qk.wallet }), qc.invalidateQueries({ queryKey: qk.me })]);
    },
  });

  return (
    <HoloPanel title={t("wallet.withdrawTitle", { sym })}>
      <div className="grid gap-4">
        <div className="flex items-end justify-between">
          <div><div className="nf-label">{t("wallet.withdrawable")}</div><CurrencyAmount amount={w.balances.nebx} currency="NEBX" symbol={sym} decimals={dec} size={20} /></div>
          <button type="button" className="nf-ui text-[12px] uppercase tracking-[0.14em] text-accent" onClick={() => setAmountStr(formatUnits(balance < BigInt(L.max) ? balance : BigInt(L.max), dec, dec))}>{t("wallet.maxBtn")}</button>
        </div>
        <label className="grid gap-1.5"><span className="nf-label">{t("wallet.amountSym", { sym })}</span><input className="nf-input" inputMode="decimal" value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>
        <label className="grid gap-1.5"><span className="nf-label">{t("wallet.destination")}</span>
          {w.wallets.length > 0 ? (
            <select className="nf-input" value={address} onChange={(e) => setAddress(e.target.value)}>{w.wallets.map((x) => <option key={x.address} value={x.address}>{shortAddr(x.address, 8)}{x.primary ? t("wallet.primarySuffix") : ""}</option>)}</select>
          ) : <input className="nf-input nf-mono" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder={t("wallet.solanaAddress")} />}
        </label>
        <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
          <FeeRow label={t("wallet.requested")} amount={quote?.requested ?? amount ?? 0n} currency="NEBX" />
          <FeeRow label={t("wallet.serviceFeePct", { pct: fmtFixed(L.serviceFeePercent * 100, 2), flat: BigInt(L.flatFee) > 0n ? t("wallet.plusFlat") : "" })} amount={quote?.serviceFee ?? 0n} currency="NEBX" negative />
          <FeeRow label={t("wallet.networkFeeEst")} amount={quote?.networkFee ?? L.estimatedNetworkFee} currency="NEBX" negative />
          <FeeRow label={t("wallet.finalAmountLabel")} amount={quote?.final ?? 0n} currency="NEBX" strong />
          {quoteErr && <div className="text-[12px] text-bad">{translateServerText(quoteErr)}</div>}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
          <div className="flex justify-between"><span className="text-mute">{t("wallet.minLabel")}</span><span>{units(L.min, dec)}</span></div>
          <div className="flex justify-between"><span className="text-mute">{t("wallet.maxLabel")}</span><span>{units(L.max, dec)}</span></div>
          <div className="col-span-2"><StatBar label={t("wallet.dailyLimit")} value={Number((BigInt(L.dailyUsed) * 1000n) / (BigInt(L.dailyLimit) || 1n))} max={1000} height={4} ghost={false} format={() => `${units(L.dailyUsed, dec)} / ${units(L.dailyLimit, dec)} ${sym}`} /></div>
          <div className="flex justify-between"><span className="text-mute">{t("wallet.cooldown")}</span><span>{t("unit.min", { n: L.cooldownMinutes })}</span></div>
          <div className="flex justify-between"><span className="text-mute">{t("wallet.nextAllowed")}</span>{L.nextAllowedAt && new Date(L.nextAllowedAt).getTime() > Date.now() ? <Countdown to={L.nextAllowedAt} className="text-[12.5px]" /> : <span className="text-good">{t("wallet.now")}</span>}</div>
        </div>
        {amount !== null && issues.map((i) => <div key={i} className="flex items-center gap-2 text-[12.5px] text-warn"><Icon name="warning" size={13} />{i}</div>)}
        <NeonButton variant="primary" disabled={!amount || amount <= 0n || issues.length > 0 || !quote} onClick={() => setConfirm(true)} icon={<Icon name="fingerprint" size={16} />}>{t("wallet.review")}</NeonButton>
      </div>
      <Modal open={confirm} onClose={() => setConfirm(false)} locked={withdraw.isPending} title={t("wallet.confirmTitle")}
        footer={<><NeonButton variant="ghost" onClick={() => setConfirm(false)} disabled={withdraw.isPending}>{t("common.cancel")}</NeonButton><NeonButton variant="primary" loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)} data-testid="withdraw-confirm">{t("wallet.confirmSign")}</NeonButton></>}>
        {quote && (
          <div className="grid gap-3">
            <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
              <FeeRow label={t("wallet.requested")} amount={quote.requested} currency="NEBX" />
              <FeeRow label={t("wallet.serviceFee")} amount={quote.serviceFee} currency="NEBX" negative />
              <FeeRow label={t("wallet.networkFee")} amount={quote.networkFee} currency="NEBX" negative />
              <FeeRow label={t("wallet.youReceive")} amount={quote.final} currency="NEBX" strong />
            </div>
            <div className="text-[13px] text-dim"><Rich text={t("wallet.toOn")} parts={{ addr: <span className="nf-mono text-ink">{address}</span>, net: <b>{w.network}</b> }} /></div>
            <p className="m-0 text-[12px] text-mute">{t("wallet.queueNote")}</p>
          </div>
        )}
      </Modal>
    </HoloPanel>
  );
}

/* ------------------------------------------------------------------ history */
function History({ w }: { w: WalletResponse }) {
  const t = useT();
  const [tab, setTab] = useState<"withdrawals" | "deposits" | "ledger">("withdrawals");
  const tx = useTransactions();
  return (
    <HoloPanel padded={false}>
      <Tabs value={tab} onChange={setTab} items={[{ key: "withdrawals", label: t("wallet.withdrawals"), count: w.withdrawals.length }, { key: "deposits", label: t("wallet.deposits"), count: w.deposits.length }, { key: "ledger", label: t("wallet.ledger") }]} />
      <div className="overflow-x-auto p-2">
        {tab === "withdrawals" && (w.withdrawals.length === 0 ? <EmptyState title={t("wallet.noWithdrawals")} icon="wallet" /> : (
          <table className="nf-table">
            <thead><tr><th>{t("wallet.requested")}</th><th>{t("wallet.fees")}</th><th>{t("wallet.final")}</th><th>{t("common.status")}</th><th>{t("wallet.signature")}</th><th>{t("common.when")}</th></tr></thead>
            <tbody>{w.withdrawals.map((x: WithdrawalDto) => (
              <tr key={x.id}>
                <td>{formatAmount(x.requested, "NEBX")}</td>
                <td className="text-dim">{formatAmount(BigInt(x.serviceFee) + BigInt(x.networkFee), "NEBX")}</td>
                <td className="nf-ui font-bold">{formatAmount(x.final, "NEBX")} {w.rewardAsset.symbol}</td>
                <td><StatusChip s={x.status} />{x.failureReason && <div className="text-[11px] text-bad">{translateServerText(x.failureReason)}</div>}</td>
                <td>{x.explorerUrl && x.signature ? <a href={x.explorerUrl} target="_blank" rel="noreferrer noopener" className="nf-mono nf-link">{shortAddr(x.signature, 6)} <Icon name="external" size={11} /></a> : <Sig sig={x.signature} />}</td>
                <td className="text-dim">{relTime(x.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        ))}
        {tab === "deposits" && (w.deposits.length === 0 ? <EmptyState title={t("wallet.noDeposits")} icon="wallet" /> : (
          <table className="nf-table">
            <thead><tr><th>{t("common.amount")}</th><th>{t("common.status")}</th><th>{t("wallet.signature")}</th><th>{t("wallet.created")}</th><th>{t("wallet.creditedCol")}</th></tr></thead>
            <tbody>{w.deposits.map((d: DepositDto) => (
              <tr key={d.id}><td><CurrencyAmount amount={d.amount} currency="SOL" size={13} /></td><td><StatusChip s={d.status} /></td><td><Sig sig={d.signature} /></td><td className="text-dim">{relTime(d.createdAt)}</td><td className="text-dim">{relTime(d.creditedAt)}</td></tr>
            ))}</tbody>
          </table>
        ))}
        {tab === "ledger" && (
          <QueryState q={tx} isEmpty={(d) => d.entries.length === 0} empty={<EmptyState title={t("wallet.noLedger")} icon="wallet" />}>
            {(d) => (
              <table className="nf-table">
                <thead><tr><th>{t("wallet.type")}</th><th>{t("wallet.asset")}</th><th className="text-right">{t("common.amount")}</th><th>{t("wallet.reference")}</th><th>{t("common.when")}</th></tr></thead>
                <tbody>{d.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{enumLabel(e.type)}</td><td className="text-dim">{e.asset}</td>
                    <td className="text-right" style={{ color: e.direction === "CREDIT" ? "var(--nf-good)" : "var(--nf-bad)" }}>{e.direction === "CREDIT" ? "+" : "−"}{formatAmount(e.amount, e.asset)}</td>
                    <td className="nf-mono text-dim">{shortAddr(e.reference, 6)}</td><td className="text-dim">{relTime(e.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </QueryState>
        )}
      </div>
    </HoloPanel>
  );
}

export default function WalletPage() {
  const t = useT();
  const q = useWallet();
  const { action } = useParams();
  const [params] = useSearchParams();
  const productParam = params.get("product");
  const focus = action === "withdraw" ? "withdraw" : action === "deposit" || productParam ? "deposit" : null;
  const order = useMemo(() => (focus === "withdraw" ? ["withdraw", "deposit"] : ["deposit", "withdraw"]), [focus]);

  return (
    <div>
      <PageHeader eyebrow={t("wallet.eyebrow")} title={t("nav.wallet")} subtitle={t("wallet.subtitle")} />
      <QueryState q={q}>
        {(w) => (
          <div className="grid gap-5">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {([
                [t("common.credits"), <CurrencyAmount key="c" amount={w.balances.credits} currency="CREDITS" size={20} />],
                [t("common.gems"), <CurrencyAmount key="g" amount={w.balances.gems} currency="GEMS" size={20} />],
                [t("wallet.brWithdrawable"), <CurrencyAmount key="n" amount={w.balances.nebx} currency="NEBX" symbol={w.rewardAsset.symbol} decimals={w.rewardAsset.decimals} size={20} />],
                [t("home.pendingReview"), <CurrencyAmount key="p" amount={w.balances.pendingRewards} currency="NEBX" symbol={w.rewardAsset.symbol} decimals={w.rewardAsset.decimals} size={20} />],
              ] as const).map(([k, v]) => <HoloPanel key={k}><div className="nf-label mb-1">{k}</div>{v}</HoloPanel>)}
            </div>
            <div className="grid items-start gap-5 xl:grid-cols-2">
              <WalletConnection w={w} />
              <RewardsPanel w={w} />
            </div>
            <div className="grid items-start gap-5 xl:grid-cols-2">
              {order.map((o) => (o === "deposit" ? <DepositPanel key="d" w={w} productParam={productParam} /> : <WithdrawPanel key="w" w={w} />))}
            </div>
            <History w={w} />
          </div>
        )}
      </QueryState>
    </div>
  );
}
