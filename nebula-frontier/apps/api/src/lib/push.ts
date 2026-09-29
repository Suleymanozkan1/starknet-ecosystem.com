/**
 * Mobile/web push delivery.
 *
 * - FCM HTTP v1: service account JSON (`FCM_SERVICE_ACCOUNT_JSON`, raw JSON or base64) -> OAuth2
 *   JWT-bearer grant (RS256 assertion signed with jose) -> `POST
 *   https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`. Used for Android and web.
 * - APNs: token-based auth (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, topic `APNS_TOPIC` = app
 *   bundle id) -> ES256 provider token -> HTTP/2 `POST /3/device/<token>` (sandbox host unless
 *   `APNS_ENV=production`). Used for iOS devices.
 *
 * When a provider's env is absent it is disabled (logged once) and notifications stay in-app only;
 * a send is reported as delivered only when the provider accepted it. The HTTP transport is
 * injectable so tests can mock the network without mocking this logic.
 */
import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";

export interface PushMessage {
  notificationId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushTarget {
  deviceId: string;
  platform: string;
  token: string;
}

export type PushResult =
  | { ok: true; provider: "fcm" | "apns" }
  | { ok: false; provider: "fcm" | "apns" | "none"; reason: string; invalidToken: boolean };

export interface HttpResponse {
  status: number;
  body: string;
}

/** Network boundary (mocked in tests). */
export interface PushTransport {
  /** HTTP/1.1 POST (FCM + Google OAuth). */
  post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse>;
  /** HTTP/2 POST (APNs). */
  http2Post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<HttpResponse>;
}

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushConfig {
  fcm: FcmServiceAccount | null;
  apns: { keyId: string; teamId: string; keyP8: string; topic: string; production: boolean } | null;
}

type Logger = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

function decodeMaybeBase64(v: string): string {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("-----")) return t;
  return Buffer.from(t, "base64").toString("utf8");
}

/** Parse push configuration from env. Invalid/partial settings disable that provider. */
export function pushConfigFromEnv(env: Record<string, string | undefined> = process.env, log?: Logger): PushConfig {
  let fcm: PushConfig["fcm"] = null;
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(decodeMaybeBase64(env.FCM_SERVICE_ACCOUNT_JSON)) as Partial<FcmServiceAccount>;
      if (sa.project_id && sa.client_email && sa.private_key) {
        fcm = { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri ?? GOOGLE_TOKEN_URI };
      } else log?.warn({ provider: "fcm" }, "FCM service account JSON is missing project_id/client_email/private_key");
    } catch {
      log?.warn({ provider: "fcm" }, "FCM_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }
  let apns: PushConfig["apns"] = null;
  const topic = env.APNS_TOPIC ?? env.APNS_BUNDLE_ID;
  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8 && topic) {
    apns = {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      keyP8: decodeMaybeBase64(env.APNS_KEY_P8).replace(/\\n/g, "\n"),
      topic,
      production: env.APNS_ENV === "production",
    };
  } else if (env.APNS_KEY_ID || env.APNS_KEY_P8) {
    log?.warn({ provider: "apns" }, "APNs partially configured (need APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_TOPIC); disabled");
  }
  return { fcm, apns };
}

/** Values in FCM `data` must be strings. */
function stringData(msg: PushMessage): Record<string, string> {
  const out: Record<string, string> = { type: msg.type };
  if (msg.notificationId) out.notificationId = msg.notificationId;
  for (const [k, v] of Object.entries(msg.data ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function buildFcmMessage(token: string, msg: PushMessage) {
  return {
    message: {
      token,
      notification: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 1000) },
      data: stringData(msg),
      android: { priority: "HIGH", notification: { channel_id: "nebula_default", tag: msg.type } },
      webpush: { headers: { Urgency: "high" } },
    },
  };
}

export function buildApnsPayload(msg: PushMessage) {
  return {
    aps: { alert: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 1000) }, sound: "default", "thread-id": msg.type },
    ...stringData(msg),
  };
}

export const defaultTransport: PushTransport = {
  async post(url, headers, body) {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.text() };
  },
  http2Post(origin, path, headers, body) {
    return http2PostOnce(origin, path, headers, body);
  },
};

/** Overall deadline for one APNs request, including connect and TLS handshake. */
export const HTTP2_TIMEOUT_MS = 10_000;

/**
 * One HTTP/2 POST on a fresh session. A single overall timer covers connect, TLS, request and
 * response; every exit path (response end, stream/session error, cancel, timeout, session close)
 * settles the promise exactly once and destroys the session, so it can never stay pending.
 */
export function http2PostOnce(
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = HTTP2_TIMEOUT_MS,
  connect: (origin: string) => http2.ClientHttp2Session = (o) => http2.connect(o),
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | null = null;
    const finish = (err: Error | null, res?: HttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session?.destroy();
      if (err) reject(err);
      else resolve(res as HttpResponse);
    };
    const timer = setTimeout(() => finish(new Error(`HTTP/2 request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      session = connect(origin);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    session.on("error", (err: Error) => finish(err));
    session.on("close", () => finish(new Error("HTTP/2 session closed before the response completed")));
    const req = session.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let data = "";
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
    });
    // A cancelled/reset stream can still emit 'end' without any response headers: that is a failure.
    req.on("end", () => finish(status ? null : new Error(`HTTP/2 stream ended without a response (code ${req.rstCode ?? "unknown"})`), { status, body: data }));
    req.on("error", (err: Error) => finish(err));
    // Stream closed without 'end' (e.g. NGHTTP2_CANCEL / RST_STREAM): fail instead of hanging.
    req.on("close", () => finish(new Error(`HTTP/2 stream closed (code ${req.rstCode ?? "unknown"})`)));
    req.end(body);
  });
}

export class PushSender {
  private cfg: PushConfig;
  private transport: PushTransport;
  private log: Logger | undefined;
  private fcmToken: { value: string; exp: number } | null = null;
  private apnsToken: { value: string; iat: number } | null = null;
  private warned = new Set<string>();

  constructor(cfg: PushConfig, transport: PushTransport = defaultTransport, log?: Logger) {
    this.cfg = cfg;
    this.transport = transport;
    this.log = log;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.fcm || this.cfg.apns);
  }

  private disabledOnce(provider: string): void {
    if (this.warned.has(provider)) return;
    this.warned.add(provider);
    this.log?.info({ provider }, "push provider not configured; notifications stay in-app only");
  }

  /** Which provider serves a device: iOS -> APNs when configured, everything else (and iOS fallback) -> FCM. */
  providerFor(platform: string): "fcm" | "apns" | null {
    if (platform === "ios" && this.cfg.apns) return "apns";
    if (this.cfg.fcm) return "fcm";
    return null;
  }

  private async fcmAccessToken(): Promise<string> {
    const sa = this.cfg.fcm;
    if (!sa) throw new Error("FCM disabled");
    const now = Math.floor(Date.now() / 1000);
    if (this.fcmToken && this.fcmToken.exp - 60 > now) return this.fcmToken.value;
    const key = await importPKCS8(sa.private_key, "RS256");
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(sa.token_uri ?? GOOGLE_TOKEN_URI)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await this.transport.post(
      sa.token_uri ?? GOOGLE_TOKEN_URI,
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    );
    if (res.status !== 200) throw new Error(`FCM OAuth token request failed (${res.status})`);
    const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("FCM OAuth response without access_token");
    this.fcmToken = { value: json.access_token, exp: now + (json.expires_in ?? 3600) };
    return json.access_token;
  }

  private async apnsProviderToken(): Promise<string> {
    const a = this.cfg.apns;
    if (!a) throw new Error("APNs disabled");
    const now = Math.floor(Date.now() / 1000);
    // Apple requires refreshing at most every 20-60 minutes.
    if (this.apnsToken && now - this.apnsToken.iat < 50 * 60) return this.apnsToken.value;
    const key = await importPKCS8(a.keyP8, "ES256");
    const value = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: a.keyId }).setIssuer(a.teamId).setIssuedAt(now).sign(key);
    this.apnsToken = { value, iat: now };
    return value;
  }

  async send(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    const provider = this.providerFor(target.platform);
    if (!provider) {
      this.disabledOnce(target.platform === "ios" ? "apns" : "fcm");
      return { ok: false, provider: "none", reason: "PUSH_DISABLED", invalidToken: false };
    }
    try {
      return provider === "apns" ? await this.sendApns(target, msg) : await this.sendFcm(target, msg);
    } catch (err) {
      this.log?.warn({ provider, err: (err as Error).message }, "push send failed");
      return { ok: false, provider, reason: "TRANSPORT_ERROR", invalidToken: false };
    }
  }

  private async sendFcm(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    const sa = this.cfg.fcm as FcmServiceAccount;
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
    const body = JSON.stringify(buildFcmMessage(target.token, msg));
    const send = async () =>
      this.transport.post(url, { authorization: `Bearer ${await this.fcmAccessToken()}`, "content-type": "application/json; charset=utf-8" }, body);
    let res = await send();
    if (res.status === 401) {
      this.fcmToken = null; // expired/revoked OAuth token: refresh once
      res = await send();
    }
    if (res.status === 200) return { ok: true, provider: "fcm" };
    const invalid = res.status === 404 || (res.status === 400 && /UNREGISTERED|INVALID_ARGUMENT|registration token/i.test(res.body));
    return { ok: false, provider: "fcm", reason: `HTTP_${res.status}`, invalidToken: invalid };
  }

  private async sendApns(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    const a = this.cfg.apns as NonNullable<PushConfig["apns"]>;
    const origin = a.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const res = await this.transport.http2Post(
      origin,
      `/3/device/${encodeURIComponent(target.token)}`,
      {
        authorization: `bearer ${await this.apnsProviderToken()}`,
        "apns-topic": a.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": msg.notificationId?.slice(0, 64) ?? msg.type,
        "content-type": "application/json",
      },
      JSON.stringify(buildApnsPayload(msg)),
    );
    if (res.status === 200) return { ok: true, provider: "apns" };
    if (res.status === 403 && /ExpiredProviderToken/.test(res.body)) this.apnsToken = null;
    const invalid = res.status === 410 || (res.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(res.body));
    return { ok: false, provider: "apns", reason: `HTTP_${res.status}`, invalidToken: invalid };
  }
}
