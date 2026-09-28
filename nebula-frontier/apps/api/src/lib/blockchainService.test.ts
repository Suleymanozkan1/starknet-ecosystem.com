/** Shared blockchain-service notifier: URL/port resolution, auth header and non-2xx handling. */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { blockchainServiceBaseUrl, notifyBlockchainServiceEnqueue } from "./blockchainService.js";

let server: Server;
let status = 200;
const seen: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders }[] = [];
const envBackup = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    res.statusCode = status;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterEach(() => {
  process.env = { ...envBackup };
  seen.length = 0;
  status = 200;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("blockchain-service notifier", () => {
  it("resolves the base URL from BLOCKCHAIN_SERVICE_URL, then BLOCKCHAIN_SERVICE_PORT", () => {
    expect(blockchainServiceBaseUrl({ BLOCKCHAIN_SERVICE_URL: "http://svc:1" })).toBe("http://svc:1");
    expect(blockchainServiceBaseUrl({ BLOCKCHAIN_SERVICE_PORT: "9123" })).toBe("http://127.0.0.1:9123");
    expect(blockchainServiceBaseUrl({})).toBe("http://127.0.0.1:8090");
  });

  it("POSTs the enqueue request with the internal token and honours BLOCKCHAIN_SERVICE_PORT", async () => {
    delete process.env.BLOCKCHAIN_SERVICE_URL;
    process.env.BLOCKCHAIN_SERVICE_PORT = String((server.address() as AddressInfo).port);
    process.env.INTERNAL_SERVICE_TOKEN = "tok";
    await notifyBlockchainServiceEnqueue("w/1");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/internal/withdrawals/w%2F1/enqueue");
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
  });

  it("rejects on non-2xx responses so callers can log the failure", async () => {
    process.env.BLOCKCHAIN_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    status = 401;
    await expect(notifyBlockchainServiceEnqueue("w1")).rejects.toThrow(/401/);
  });
});
