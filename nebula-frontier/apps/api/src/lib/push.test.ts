/**
 * Push sender unit tests: payload building, disabled path, FCM OAuth + send, APNs provider token +
 * HTTP/2 send, invalid-token handling. Only the HTTP transport is mocked.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, importSPKI, jwtVerify, type JWK } from "jose";
import { PushSender, buildApnsPayload, buildFcmMessage, pushConfigFromEnv, type HttpResponse, type PushTransport } from "./push.js";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ecPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const SA = { type: "service_account", project_id: "nebula-test", client_email: "push@nebula-test.iam.gserviceaccount.com", private_key: rsaPem, token_uri: "https://oauth2.googleapis.com/token" };
const ENV = {
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(SA),
  APNS_KEY_ID: "ABC123DEFG",
  APNS_TEAM_ID: "TEAM123456",
  APNS_KEY_P8: ecPem,
  APNS_TOPIC: "com.nebula.frontier",
};

interface Call { kind: "post" | "h2"; url: string; headers: Record<string, string>; body: string }

function mockTransport(responder: (c: Call) => HttpResponse): { transport: PushTransport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      async post(url, headers, body) {
        const c: Call = { kind: "post", url, headers, body };
        calls.push(c);
        return responder(c);
      },
      async http2Post(origin, path, headers, body) {
        const c: Call = { kind: "h2", url: origin + path, headers, body };
        calls.push(c);
        return responder(c);
      },
    },
  };
}

const okGoogle = (c: Call): HttpResponse =>
  c.url.includes("oauth2") ? { status: 200, body: JSON.stringify({ access_token: "ya29.test-token", expires_in: 3600 }) } : { status: 200, body: "{}" };

const msg = { notificationId: "n1", type: "AUCTION_WON", title: "Auction won", body: "You won", data: { auctionId: "a1", amount: 5, nested: { x: 1 } } };

describe("payload building", () => {
  it("builds an FCM v1 message with string-only data", () => {
    const m = buildFcmMessage("tok", msg);
    expect(m.message.token).toBe("tok");
    expect(m.message.notification).toEqual({ title: "Auction won", body: "You won" });
    expect(m.message.data).toEqual({ type: "AUCTION_WON", notificationId: "n1", auctionId: "a1", amount: "5", nested: '{"x":1}' });
    expect(m.message.android.priority).toBe("HIGH");
  });

  it("builds an APNs payload with alert + custom keys", () => {
    const p = buildApnsPayload(msg);
    expect(p.aps.alert).toEqual({ title: "Auction won", body: "You won" });
    expect(p.aps["thread-id"]).toBe("AUCTION_WON");
    expect(p).toMatchObject({ auctionId: "a1", notificationId: "n1" });
  });
});

describe("configuration", () => {
  it("is disabled without credentials and never reports success", async () => {
    const logs: string[] = [];
    const log = { info: (_o: object, m?: string) => logs.push(m ?? ""), warn: (_o: object, m?: string) => logs.push(m ?? "") };
    const { transport, calls } = mockTransport(okGoogle);
    const sender = new PushSender(pushConfigFromEnv({}), transport, log);
    expect(sender.enabled).toBe(false);
    const r1 = await sender.send({ deviceId: "d", platform: "android", token: "t" }, msg);
    const r2 = await sender.send({ deviceId: "d", platform: "android", token: "t" }, msg);
    expect(r1).toEqual({ ok: false, provider: "none", reason: "PUSH_DISABLED", invalidToken: false });
    expect(r2.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => l.includes("not configured"))).toHaveLength(1); // logged once
  });

  it("parses base64 service accounts and rejects partial APNs config", () => {
    const cfg = pushConfigFromEnv({ FCM_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(SA)).toString("base64"), APNS_KEY_ID: "x" });
    expect(cfg.fcm?.project_id).toBe("nebula-test");
    expect(cfg.apns).toBeNull();
    expect(pushConfigFromEnv({ FCM_SERVICE_ACCOUNT_JSON: "{not json" }).fcm).toBeNull();
  });
});

describe("FCM HTTP v1", () => {
  it("exchanges a signed JWT assertion for an access token and sends the message", async () => {
    const { transport, calls } = mockTransport(okGoogle);
    const sender = new PushSender(pushConfigFromEnv(ENV), transport);
    const res = await sender.send({ deviceId: "d1", platform: "android", token: "fcm-token-1" }, msg);
    expect(res).toEqual({ ok: true, provider: "fcm" });
    const [tokenCall, sendCall] = calls;
    expect(tokenCall?.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(tokenCall?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const pub = await importSPKI(rsa.publicKey.export({ type: "spki", format: "pem" }).toString(), "RS256");
    const { payload } = await jwtVerify(form.get("assertion") ?? "", pub, { audience: SA.token_uri, issuer: SA.client_email });
    expect(payload.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(sendCall?.url).toBe("https://fcm.googleapis.com/v1/projects/nebula-test/messages:send");
    expect(sendCall?.headers.authorization).toBe("Bearer ya29.test-token");
    expect(JSON.parse(sendCall?.body ?? "{}").message.token).toBe("fcm-token-1");
    // Access token is cached.
    await sender.send({ deviceId: "d1", platform: "web", token: "fcm-token-2" }, msg);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  it("flags unregistered tokens as invalid and treats 5xx as transient", async () => {
    let status = 404;
    const { transport } = mockTransport((c) => (c.url.includes("oauth2") ? okGoogle(c) : { status, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' }));
    const sender = new PushSender(pushConfigFromEnv(ENV), transport);
    const r = await sender.send({ deviceId: "d", platform: "android", token: "dead" }, msg);
    expect(r).toMatchObject({ ok: false, provider: "fcm", invalidToken: true });
    status = 503;
    const r2 = await sender.send({ deviceId: "d", platform: "android", token: "t" }, msg);
    expect(r2).toMatchObject({ ok: false, reason: "HTTP_503", invalidToken: false });
  });

  it("refreshes the OAuth token once on 401", async () => {
    let sends = 0;
    const { transport, calls } = mockTransport((c) => {
      if (c.url.includes("oauth2")) return okGoogle(c);
      sends++;
      return sends === 1 ? { status: 401, body: "" } : { status: 200, body: "{}" };
    });
    const sender = new PushSender(pushConfigFromEnv(ENV), transport);
    expect((await sender.send({ deviceId: "d", platform: "android", token: "t" }, msg)).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(2);
  });
});

describe("APNs", () => {
  it("sends over HTTP/2 with an ES256 provider token to the sandbox host", async () => {
    const { transport, calls } = mockTransport(() => ({ status: 200, body: "" }));
    const sender = new PushSender(pushConfigFromEnv(ENV), transport);
    const res = await sender.send({ deviceId: "d", platform: "ios", token: "apns-token" }, msg);
    expect(res).toEqual({ ok: true, provider: "apns" });
    const c = calls[0];
    expect(c?.kind).toBe("h2");
    expect(c?.url).toBe("https://api.sandbox.push.apple.com/3/device/apns-token");
    expect(c?.headers["apns-topic"]).toBe("com.nebula.frontier");
    expect(c?.headers["apns-push-type"]).toBe("alert");
    const jwk = (await exportJWK(ec.publicKey)) as JWK;
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "ABC123DEFG", alg: "ES256" }] });
    const token = c?.headers.authorization?.replace(/^bearer /, "") ?? "";
    const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer: "TEAM123456" });
    expect(protectedHeader.kid).toBe("ABC123DEFG");
    expect(typeof payload.iat).toBe("number");
    expect(JSON.parse(c?.body ?? "{}").aps.alert.title).toBe("Auction won");
  });

  it("uses the production host and marks 410 tokens invalid", async () => {
    const { transport, calls } = mockTransport(() => ({ status: 410, body: '{"reason":"Unregistered"}' }));
    const sender = new PushSender(pushConfigFromEnv({ ...ENV, APNS_ENV: "production" }), transport);
    const res = await sender.send({ deviceId: "d", platform: "ios", token: "old" }, msg);
    expect(res).toMatchObject({ ok: false, provider: "apns", invalidToken: true });
    expect(calls[0]?.url.startsWith("https://api.push.apple.com/")).toBe(true);
  });

  it("falls back to FCM for iOS devices when APNs is not configured", () => {
    const sender = new PushSender(pushConfigFromEnv({ FCM_SERVICE_ACCOUNT_JSON: ENV.FCM_SERVICE_ACCOUNT_JSON }));
    expect(sender.providerFor("ios")).toBe("fcm");
    expect(new PushSender(pushConfigFromEnv({})).providerFor("android")).toBeNull();
  });
});
