import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getBase58Decoder } from "@solana/kit";

/**
 * BC-02 — wallet sign-in through the Wallet Standard (the discovery protocol Phantom, Solflare and Backpack
 * use). A mock wallet registers itself via the `wallet-standard:register-wallet` window event before the app
 * loads; the test then signs in from /login against the real API, which verifies the ed25519 signature over
 * its SIWS challenge and opens a session (see playwright.wallet.config.ts for the stack it starts).
 */

const WALLET_NAME = "E2E Standard Wallet";
const SOLANA_CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"];
const ICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6ee7ff"/></svg>').toString("base64")}`;

interface MockWalletConfig {
  name: string;
  icon: string;
  address: string;
  publicKey: number[];
  chains: string[];
}

/**
 * Runs in the page before any app script (page.addInitScript). Implements the Wallet Standard wallet
 * interface (standard:connect / standard:disconnect / standard:events + solana:signMessage, and
 * solana:signTransaction so wallet-adapter treats it as Solana-compatible) and registers it with both
 * halves of the discovery handshake: dispatching `wallet-standard:register-wallet` now, and answering
 * `wallet-standard:app-ready` when the app starts listening later. Signing is delegated to the test
 * process (window.__nfMockWalletSign), which holds the ed25519 secret key.
 */
function installMockWallet(cfg: MockWalletConfig): void {
  type ChangeListener = (properties: { accounts?: readonly unknown[] }) => void;
  interface SignMessageInput {
    account: unknown;
    message: Uint8Array;
  }
  interface Bridge {
    __nfMockWalletSign?: (messageBase64: string) => Promise<string>;
  }
  const bridge = window as Window & Bridge;
  const toBase64 = (bytes: Uint8Array): string => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const account = Object.freeze({
    address: cfg.address,
    publicKey: new Uint8Array(cfg.publicKey),
    chains: cfg.chains,
    features: ["solana:signMessage", "solana:signTransaction"],
    label: "E2E account",
  });
  let accounts: (typeof account)[] = [];
  const listeners = new Set<ChangeListener>();
  const emitChange = (): void => {
    for (const l of listeners) l({ accounts });
  };

  const wallet = {
    version: "1.0.0" as const,
    name: cfg.name,
    icon: cfg.icon,
    chains: cfg.chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = [account];
          emitChange();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          emitChange();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, listener: ChangeListener) => {
          if (event !== "change") return () => undefined;
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: SignMessageInput[]) => {
          const signer = bridge.__nfMockWalletSign;
          if (!signer) throw new Error("mock wallet signer not attached");
          const out: { signedMessage: Uint8Array; signature: Uint8Array; signatureType: "ed25519" }[] = [];
          for (const input of inputs) {
            if (input.account !== account) throw new Error("unknown account");
            out.push({ signedMessage: input.message, signature: fromBase64(await signer(toBase64(input.message))), signatureType: "ed25519" });
          }
          return out;
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async () => {
          throw new Error("The E2E wallet does not sign transactions");
        },
      },
    },
  };

  type RegisterApi = { register: (w: typeof wallet) => unknown };
  const callback = (api: RegisterApi): void => {
    api.register(wallet);
  };
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  // The app's AppReadyEvent is a plain Event subclass exposing `detail` (not a CustomEvent).
  window.addEventListener("wallet-standard:app-ready", (e: Event) => {
    const api = (e as Event & { detail?: RegisterApi }).detail;
    if (api) callback(api);
  });
}

interface InstalledWallet {
  address: string;
  /** UTF-8 messages the wallet was asked to sign, in order. */
  signed: string[];
  /** Signatures it returned (same order). */
  signatures: Buffer[];
  publicKey: KeyObject;
}

/** Generates an ed25519 key pair, attaches the signer bridge and injects the mock wallet before navigation. */
async function injectWallet(page: Page, opts: { tamper?: boolean } = {}): Promise<InstalledWallet> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("no ed25519 public key");
  const raw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  expect(raw.length).toBe(32);
  const address = getBase58Decoder().decode(raw);
  const signed: string[] = [];
  const signatures: Buffer[] = [];
  await page.exposeFunction("__nfMockWalletSign", (messageBase64: string): string => {
    const message = Buffer.from(messageBase64, "base64");
    signed.push(message.toString("utf8"));
    const signature = sign(null, message, privateKey);
    if (opts.tamper) signature[0] = (signature[0] ?? 0) ^ 0xff;
    signatures.push(signature);
    return signature.toString("base64");
  });
  await page.addInitScript(installMockWallet, { name: WALLET_NAME, icon: ICON, address, publicKey: [...raw], chains: SOLANA_CHAINS });
  return { address, signed, signatures, publicKey };
}

/** /login → Wallet tab → wallet modal lists the injected wallet → choose it (connect + SIWS signing follows). */
async function signInWithMockWallet(page: Page): Promise<void> {
  await page.goto("/login");
  const tab = page.getByRole("tab", { name: "Wallet", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("wallet-signin").click();
  const modal = page.locator(".wallet-adapter-modal");
  await expect(modal).toBeVisible();
  const entry = modal.locator(".wallet-adapter-modal-list li", { hasText: WALLET_NAME });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("Detected");
  await entry.getByRole("button").click();
}

interface MeProbe {
  status: number;
  wallets: { address: string; primary: boolean }[];
}

async function fetchMe(page: Page): Promise<MeProbe> {
  return page.evaluate(async () => {
    const r = await fetch("/api/me", { credentials: "include" });
    const body: unknown = r.ok ? await r.json() : null;
    const wallets = body && typeof body === "object" && "wallets" in body && Array.isArray(body.wallets) ? (body.wallets as { address: string; primary: boolean }[]) : [];
    return { status: r.status, wallets };
  });
}

test.describe("wallet · Wallet Standard sign-in (real API)", () => {
  test("injected Wallet Standard wallet is detected and signs in with a verified SIWS signature", async ({ page, baseURL }) => {
    const wallet = await injectWallet(page);
    await signInWithMockWallet(page);

    // New wallet → new account → onboarding. The session cookie is only issued after the API verified the signature.
    await page.waitForURL(/\/onboarding\/faction/, { timeout: 60_000 });

    expect(wallet.signed).toHaveLength(1);
    const message = wallet.signed[0] ?? "";
    const host = new URL(baseURL ?? "http://localhost:4191").host;
    expect(message.startsWith(`${host} wants you to sign in with your Solana account:\n${wallet.address}\n`)).toBe(true);
    expect(message).toContain("Purpose: LOGIN");
    expect(message).toContain("Chain ID: solana:devnet");
    expect(message).toMatch(/\nNonce: [A-Za-z0-9]{16,}\n/);
    expect(message).toMatch(/\nExpiration Time: \d{4}-\d{2}-\d{2}T/);
    // What the wallet returned is a valid ed25519 signature by the wallet key over the exact challenge.
    const signature = wallet.signatures[0];
    if (!signature) throw new Error("no signature recorded");
    expect(verify(null, Buffer.from(message, "utf8"), wallet.publicKey, signature)).toBe(true);

    const me = await fetchMe(page);
    expect(me.status).toBe(200);
    expect(me.wallets).toEqual([expect.objectContaining({ address: wallet.address, primary: true })]);
  });

  test("a wallet whose signature does not verify is rejected by the API", async ({ page }) => {
    const wallet = await injectWallet(page, { tamper: true });
    await signInWithMockWallet(page);

    await expect(page.getByRole("alert")).toContainText(/signature/i, { timeout: 30_000 });
    expect(wallet.signed).toHaveLength(1);
    await expect(page).toHaveURL(/\/login/);
    expect((await fetchMe(page)).status).toBe(401);
  });
});
