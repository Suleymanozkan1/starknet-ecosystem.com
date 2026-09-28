# NEBULA FRONTIER — Security

Scope: `apps/api` (Fastify REST), `packages/authentication`, `packages/validation`, and the security
contracts other services rely on (game tickets, presence, risk signals). Chain-side controls
(treasury key, withdrawal queue) are in `apps/blockchain-service` and `packages/blockchain`.

Threat model in one paragraph: players are adversarial (cheats, duplication, multi-accounting,
wash trading, credential stuffing), the client is untrusted (every price, amount, position and
outcome is decided server-side), money and items move only through the double-entry ledger and
escrow with idempotency keys, and administrators are powerful but audited and least-privileged.

---

## 1. OWASP Top 10 (2021) mapping

| OWASP | Risk in this system | Controls (where) |
|---|---|---|
| A01 Broken Access Control | IDOR on items/ships/listings/mail/quests; admin abuse | Every query is scoped by `req.user.id` (`userId` in `where`); foreign rows return **404** (no existence oracle). RBAC matrix `ADMIN_PERMISSIONS` (`packages/authentication/src/rbac.ts`) enforced by `app.requireRole`. Clan role checks `canSetClanRole` / `canKickClanMember`. Tests: IDOR equip, 403 admin (`tests/integration/*.test.ts`). |
| A02 Cryptographic Failures | Token theft, weak password storage | argon2id (m=19 MiB, t=2, p=1). JWT HS256 with ≥32-char secrets (startup refuses dev placeholders in production). Refresh tokens are 32 random bytes, only `sha256` stored. Cookies `Secure` in production, HSTS preload. |
| A03 Injection | SQL / JSON / log injection | Prisma parameterised queries only (`$queryRaw` tagged templates). zod parses every body/query/param (`packages/validation`), unknown keys stripped, control characters rejected in free text. Fastify `onProtoPoisoning: error` default. |
| A04 Insecure Design | Duplication, race conditions, client-trusted prices | SERIALIZABLE transactions with retry (`withSerializableTx`), conditional updates (`lockedBy IS NULL`, `version`, `claimedAt IS NULL`), unique `originRef` / `idempotencyKey`, prices only from `ShopProduct`. Race tests with `Promise.all`. |
| A05 Security Misconfiguration | Verbose errors, permissive CORS | Uniform `ApiError`; stack/messages of 5xx hidden in production. CORS allowlist (`CORS_ORIGINS`) with credentials; Helmet with `default-src 'none'` CSP for the JSON API. Env validated at boot (`apps/api/src/env.ts`). |
| A06 Vulnerable Components | Supply chain | Lockfile pinned, `pnpm` with `onlyBuiltDependencies`, Dependabot/`pnpm audit` in CI (see DEPLOYMENT.md). |
| A07 Identification & Auth Failures | Credential stuffing, session fixation, replay | IP rate limits + per-account lockout (5 fails → 15 min), timing-equalised unknown-account path, SIWS nonce single-use + 5 min expiry, rotating refresh tokens with reuse detection → revoke all sessions, fresh CSRF token minted at login. |
| A08 Software & Data Integrity | Tampered game messages, unsigned tickets | Game tickets are 60 s JWTs (aud `game`, `jti` recorded in Redis for single use). Client game messages validated with `clientMessageSchemas`. Ledger rows immutable, compensating entries only. |
| A09 Logging & Monitoring Failures | Undetected fraud / admin abuse | pino JSON logs with redaction, request + correlation ids, `AuditLog` for every admin mutation (actor, old/new value, reason, IP, request id), `RiskSignal` stream, Prometheus `/metrics`. |
| A10 SSRF | Server fetching attacker URLs | The API makes no user-controlled outbound requests; chain RPC endpoints come from env only. |

---

## 2. Authentication

### 2.1 Wallet login (Sign-In-With-Solana style)

1. `POST /api/auth/nonce {address, purpose:"LOGIN"|"LINK_WALLET"}` → server stores a `WalletNonce`
   (62-alphabet CSPRNG nonce, 32 chars, **5 min** expiry, requester IP) and returns the exact text to
   sign (`buildLoginMessage` from `@nebula/blockchain`: domain, address, statement, URI, chain
   `solana:devnet`, purpose, nonce, issued-at, expiration).
2. Wallet signs the UTF-8 bytes (`signMessage`).
3. `POST /api/auth/verify {address, nonce, signature(base58), deviceId?}`:
   - nonce must exist, match address + purpose, be unused and unexpired (optionally same IP when
     `WALLET_NONCE_BIND_IP=true`);
   - nonce is **consumed atomically** (`UPDATE … WHERE usedAt IS NULL AND expiresAt > now()`) *before*
     signature verification, so a nonce can never be used twice, even concurrently or with a bad
     signature (no grinding);
   - ed25519 verification over the **stored** message (`verifyWalletSignature`).
   - First login creates `User` (`pilot_<8 hex>`), primary `Wallet`, `PlayerStat`.
4. Linking another wallet: `POST /api/auth/link-wallet` (authenticated, `purpose: LINK_WALLET` nonce
   bound to the user id) → notification + audit + `WALLET_CHANGE` risk signal. The withdrawal flow
   applies `withdrawal.walletChangeLockHours` (economy config) to newly linked wallets.

### 2.2 Email / password

`POST /api/auth/register` (argon2id), `POST /api/auth/login`. Brute force: per-IP route limit plus a
per-account counter in Redis (`auth:fail:<sha256(email)>`): 5 failures → `auth:lock` for 15 min
(`429 ACCOUNT_LOCKED`), `BRUTE_FORCE_LOGIN` risk signal and a security notification. Unknown
emails run a dummy argon2 verification (no user-enumeration timing oracle).

### 2.3 Sessions and tokens

| Token | Format | Lifetime | Storage |
|---|---|---|---|
| Access | JWT HS256 with `kid` (key ring, §7.1), `aud=api`, `iss=nebula-frontier`, claims `sub, username, roles, sid` | 15 min | cookie `nf_access` (httpOnly) or `Authorization: Bearer` |
| Refresh | `<sessionId>.<32 random bytes b64url>` | 30 days (sliding on rotation) | cookie `nf_refresh` (httpOnly, `Path=/api/auth`); DB keeps `sha256(secret)` only |
| CSRF | 24 random bytes b64url | 30 days | cookie `nf_csrf` (readable by JS) |
| Game ticket | JWT HS256 with `kid`, `aud=game`, `jti`, `mapId` | 60 s | returned by `POST /api/game/ticket`, `gt:<jti>` in Redis for single use |

`app.authenticate` verifies the JWT **and** loads the session every request: revoked/expired
session → `401 SESSION_REVOKED`; banned user → `403 ACCOUNT_BANNED`. Roles come from the DB
(`AdminUser.roles`), not from the token, so role removal is immediate.

**Refresh rotation + reuse detection** (`POST /api/auth/refresh`): the presented secret must match
the session's current hash; on success the hash is replaced atomically (`WHERE refreshTokenHash =
old`). If an *older* secret of a live session is presented, it is treated as theft: **all sessions of
the user are revoked**, a `REFRESH_TOKEN_REUSE` risk signal and a security notification are
created (`401 TOKEN_REUSE`). A 30 s grace key (`rt:grace:<oldHash>`) turns a benign multi-tab race into
`409 REFRESH_RACE` instead of a global logout.

`POST /api/auth/logout` (revoke current), `POST /api/auth/logout-all`, `GET /api/auth/sessions`,
`DELETE /api/auth/sessions/:id`. Bans and role changes revoke all sessions.

---

## 3. Cookie & CSRF contract (for the web / admin / mobile clients)

Cookies set by `/api/auth/verify`, `/login`, `/register`, `/refresh`:

| Cookie | httpOnly | Path | SameSite | Secure | Max-Age |
|---|---|---|---|---|---|
| `nf_access` | yes | `/` | Lax | production | 900 s |
| `nf_refresh` | yes | `/api/auth` | Lax | production | 30 d |
| `nf_csrf` | **no** | `/` | Lax | production | 30 d |

`Domain` is set from `COOKIE_DOMAIN` when configured (e.g. `.nebula.example` for `app.` + `api.`).

**Double-submit rule:** every `POST/PUT/PATCH/DELETE` authenticated **by cookie** must send header
`x-nf-csrf: <value of the nf_csrf cookie>`; otherwise `403 CSRF_FAILED`. The same applies to
`/api/auth/refresh` and `/api/auth/logout` (cookie-only endpoints). The response body of the auth
endpoints also contains `csrfToken` for clients that cannot read cookies of the API origin.
Additionally, if an `Origin` header is present it must be in `CORS_ORIGINS`.

Client recipe (web):

```ts
const csrf = document.cookie.match(/(?:^|; )nf_csrf=([^;]+)/)?.[1];
fetch("/api/shop/purchase", {
  method: "POST",
  credentials: "include",
  headers: { "content-type": "application/json", ...(csrf ? { "x-nf-csrf": csrf } : {}) },
  body: JSON.stringify({ productId, quantity: 1, idempotencyKey: crypto.randomUUID() }),
});
// On 401 with code SESSION_REVOKED/UNAUTHORIZED: POST /api/auth/refresh (with x-nf-csrf) once, then retry.
```

Requests authenticated with `Authorization: Bearer` (game server tools, native clients) are not
subject to CSRF (browsers never attach that header automatically). Login endpoints do not require
CSRF (no session yet); login-CSRF is mitigated by SameSite=Lax, JSON-only bodies and the CORS
allowlist, and a fresh CSRF token is always minted at login (a pre-login cookie is never reused).

---

## 4. Rate limits

Redis-backed (`@fastify/rate-limit`, shared by all API replicas). Key = verified user id when an
access token is present, otherwise client IP (`TRUST_PROXY=true` behind a load balancer).

| Scope | Limit | Key | Where |
|---|---|---|---|
| Global default | 300 / min | user or IP | every route |
| `auth` (nonce, login, refresh) | 20 / min | IP | `/api/auth/*` |
| `authVerify` (verify, link-wallet) | 10 / min | IP | SIWS verification |
| `register` | 5 / 10 min | IP | `/api/auth/register` |
| Account lockout | 5 failures → 15 min | email hash | `/api/auth/login` |
| `wallet` + `rateLimitStrict` | 20 / min + 10 / min | user | wallet connect / deposits |
| `withdrawal` + `rateLimitWithdrawal` | 3 / min **and** 10 / hour | user | withdrawal requests |
| `purchase` | 20 / min | user | shop, ship unlock/upgrade, crafting, item upgrade |
| `market` | 30 / min | user | market list/buy/cancel, auctions |
| `bid` + per-user bid limiter | 10 / min | user | auction bids |
| `chat` | 30 / min | user | chat history / report (in-game chat is limited by the game server) |
| `social` | 60 / min | user | clans, squads, friends |
| `admin` | 120 / min | user | `/api/admin/*` |
| Game ticket | 30 / min | user | `/api/game/ticket` |

Exceeded → `429 RATE_LIMITED` with `retry-after`.

---

## 5. RBAC matrix

Source of truth: `ADMIN_PERMISSIONS` in `packages/authentication/src/rbac.ts`. `SUPER_ADMIN`
implicitly has every permission. ✔ = allowed.

| Capability (routes) | SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT | ECONOMY_MANAGER |
|---|---|---|---|---|---|
| overview `GET /api/admin/overview` | ✔ | ✔ | ✔ | ✔ | ✔ |
| usersRead `GET /api/admin/users[/:id]` | ✔ | ✔ | ✔ | ✔ | |
| usersBan `POST …/ban`, `…/unban` | ✔ | ✔ | ✔ | | |
| usersMute `POST …/mute`, `…/unmute` | ✔ | ✔ | ✔ | | |
| rolesManage `PUT …/roles` | ✔ | | | | |
| riskRead `GET /api/admin/risk` | ✔ | ✔ | ✔ | | ✔ |
| riskReview `POST /api/admin/risk/:id/review` | ✔ | ✔ | ✔ | | |
| reports `GET/POST /api/admin/reports…` | ✔ | ✔ | ✔ | | |
| shopManage `…/shop/products` CRUD | ✔ | ✔ | | | ✔ |
| eventsRead / eventsManage | ✔ | ✔ / ✔ | ✔ / | | ✔ / |
| catalogManage `PUT /api/admin/catalog/:kind/:id` | ✔ | ✔ | | | |
| featureFlags `…/feature-flags` | ✔ | ✔ | | | |
| rulesManage `…/rules` | ✔ | ✔ | | | ✔ |
| mailGrant `POST /api/admin/mail` (compensation) | ✔ | ✔ | | | |
| auditRead `GET /api/admin/audit` | ✔ | ✔ | | | |
| analytics `GET /api/admin/analytics` | ✔ | ✔ | | | ✔ |
| economyRead / economyManage / withdrawalReview (economy routes) | ✔ | ✔ / – / ✔ | | | ✔ / ✔ / ✔ |

Every admin mutation writes an `AuditLog` row **in the same transaction** as the change
(`app.audit(req, entry, tx)`): actor, action, target, old/new value, mandatory reason, IP, request
id, correlation id. Bans are **always manual** (automated systems only raise `RiskSignal`s and
risk levels). Products and events are deactivated, never hard-deleted.

---

## 6. Compliance gating (feature flags)

`app.requireFeature(key)` (after `authenticate`) checks the `FeatureFlag` row: `enabled` plus rules
`allowCountries/denyCountries`, `allowRegions/denyRegions`, `minAge` (from `User.birthYear`),
`requireKyc` (`NONE|BASIC|FULL` vs `User.kycStatus`), `denyRestrictions` (`User.restrictions`),
`maxRiskLevel`. Seeded keys: `wallet`, `deposit`, `withdraw`, `marketplace_crypto` (disabled by
default, 18+), `nft_mint`. Crypto-priced (`NEBX`) market listings/purchases require
`marketplace_crypto`; the wallet/deposit/withdraw routes should apply `wallet` / `deposit` /
`withdraw`. KYC is a placeholder status field ready for a provider integration.

---

## 7. Secrets management

| Stage | Practice |
|---|---|
| MVP (now) | Secrets only in environment variables (`.env` never committed; `.env.example` has empty values). API refuses to start in production with placeholder-looking `JWT_SECRET`/`GAME_TICKET_SECRET` or non-devnet network. Treasury key exists **only** in `apps/blockchain-service`. |
| Staging | Platform secret store (e.g. Fly/Render/Kubernetes Secrets sealed with SOPS), per-environment secrets, rotation runbook. |
| Production | Cloud KMS / Secret Manager for app secrets with short-lived workload identity; **treasury signing in an HSM or KMS-backed signer** (the key never leaves the HSM; blockchain-service sends transactions for signing), multi-sig for cold reserves, dual control for limit changes. |

### 7.1 JWT key rotation (zero downtime)

Access tokens and game tickets are HS256 JWTs signed from a **key ring** (`packages/authentication`
`parseKeyRing` / `keyRingFromEnv`):

| Variable | Format | Meaning |
|---|---|---|
| `JWT_SECRETS` | `kid:secret,kid:secret,…` | First entry = **active** signing key; every entry is accepted for verification. |
| `JWT_SECRET` | `secret` | Legacy single key, used (as kid `default`) only when `JWT_SECRETS` is empty. |
| `GAME_TICKET_SECRETS` / `GAME_TICKET_SECRET` | same | Independent ring for game tickets (API signs, game server verifies). |

Rules: kid `[A-Za-z0-9._-]{1,32}`, unique; every secret ≥ 32 chars; production refuses
placeholder-looking secrets. New tokens carry the active `kid` in the JWS header; verification
selects the key by `kid` (an unknown `kid` is rejected — never "try all keys" for a kid-bearing
token) and tries every key only for legacy tokens without `kid`. The exported functions keep their
signatures: passing a plain string still signs/verifies without `kid`.

Rotation runbook:
1. Generate a new secret (`openssl rand -base64 48`) and **prepend** it: `JWT_SECRETS=k2:<new>,default:<old>`
   (use `default:<old>` when migrating from `JWT_SECRET`). For tickets, first add the new key to the
   game servers' verification ring, then make it active in the API.
2. Roll out all API replicas (and game servers for tickets). Old tokens keep verifying; new tokens use `k2`.
3. Wait at least the maximum token lifetime (access 15 min, tickets 60 s; refresh tokens are opaque
   DB secrets and are unaffected).
4. Remove the old entry: `JWT_SECRETS=k2:<new>`. Tokens signed with the retired key now fail (401).
Emergency revocation (key leak): skip step 3 — replace the ring with only the new key; all users
re-authenticate transparently through `/api/auth/refresh` (sessions are DB-backed).

### 7.2 Service-to-service token

`INTERNAL_SERVICE_TOKEN` (≥ 32 chars) authenticates game server → API calls on `/api/internal/*`
(header `x-internal-token`, constant-time compare). Player credentials are never accepted there; if
the variable is unset the internal API answers 503. Rotate like any shared secret (deploy API
accepting both is not supported yet: rotate during a short maintenance window).

### 7.3 Push provider credentials

`FCM_SERVICE_ACCOUNT_JSON` (raw JSON or base64; only `project_id`, `client_email`, `private_key`
are used, the private key signs a short-lived OAuth assertion) and `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_KEY_P8`, `APNS_TOPIC` (+ `APNS_ENV=production` for the production gateway) are secrets and
are redacted from logs. When absent, push is disabled and notifications remain in-app only.

---

## 8. Logging, tracing, redaction

- Logger: `@nebula/telemetry` `createLogger` (pino JSON) with redaction of passwords, tokens,
  tickets, JWTs, cookies, `authorization`, signatures, secrets, private keys and seed phrases, plus
  API-specific paths (`x-nf-csrf`, nonces, `csrfToken`); free-form strings are scrubbed for JWTs,
  cookies and byte-array keys.
- Request id: inbound `x-request-id` accepted if well-formed, else UUID; echoed in the
  `x-request-id` response header and in every `ApiError`. Correlation id: `x-correlation-id`
  (defaults to the request id), stored on audit rows and ledger postings.
- Metrics: `GET /metrics` (optional `METRICS_TOKEN` bearer), request latency histogram per route,
  auth events, purchases. Health: `GET /health` (liveness), `GET /ready` (DB + Redis latency).
- Audit retention: see DATABASE.md (≥ 2 years, append-only).

---

## 9. Anti-cheat and bot detection (overview)

- **Authoritative server**: clients send intents; the game server simulates with `@nebula/game-core`
  (same formulas as the API) and validates every message with `clientMessageSchemas`
  (`packages/validation/src/game.ts`: bounded finite numbers, enums, ids, chat text without control
  characters). Invalid/unknown messages are dropped and counted (packet spam).
- **Server-side outcomes**: loot, XP, credits, quest progress and achievements are written by
  servers only; the API only *claims* against server-recorded progress, atomically.
- **Risk signals** (`recordRiskSignal`, `RiskSignal` table → `User.riskScore/riskLevel`): speed /
  teleport / fire-rate / cooldown anomalies (game server), duplicate claims, refresh-token reuse,
  brute force, suspicious logins, wallet changes, wash trading. High risk gates rewards and
  withdrawals (economy eligibility) and surfaces in the admin risk queue; humans decide bans.
- **Economy abuse**: wash-trade detection on market buys, bids and buyouts (shared client device
  id, shared non-loopback IP in the last 30 days, deposit/withdrawal wallet cross-links) → both
  accounts flagged `TRADE_EXPLOIT` and the trade is blocked (`403 TRADE_BLOCKED`). Seller cannot buy
  or bid on own listings; per-user bid rate limit; anti-sniping extension.
- **Duplication**: items carry unique `originRef`, escrow via `lockedBy` + `version`, SERIALIZABLE
  transactions, ledger idempotency keys; equipped items cannot be listed and listed items cannot be
  equipped (tested with concurrent requests).

---

## 10. Account security features

| Event | Server behaviour |
|---|---|
| New wallet linked | Single-use LINK_WALLET nonce bound to the account; notification; audit; `WALLET_CHANGE` risk signal; withdrawals to the new wallet locked for `walletChangeLockHours`. |
| New device | `Device` (client `deviceId` or UA hash) recorded; if the account already had devices → `SECURITY_NEW_DEVICE` notification. |
| Suspicious login | New device **and** IP never seen for this account in 90 days → `SUSPICIOUS_LOGIN` risk signal. |
| Password brute force | Lockout + notification + risk signal. |
| Stolen refresh token | Reuse detection → revoke all sessions + notification + risk signal. |
| Ban / role change | All sessions revoked immediately. |

---

## 11. HTTP hardening

Helmet: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'`, `Cross-Origin-Resource-Policy: same-site`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, HSTS (production). `Cache-Control: no-store` on `/api/*`. Body
limit 256 KiB. JSON only. BigInt amounts are serialized as decimal strings.
