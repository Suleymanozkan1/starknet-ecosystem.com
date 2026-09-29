/** http2PostOnce: overall deadline (connect included) and no pending promise on cancelled streams. */
import http2 from "node:http2";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http2PostOnce } from "./push.js";

let h2: http2.Http2Server;
let silent: net.Server;
const sockets = new Set<net.Socket>();
let h2Origin = "";
let silentOrigin = "";

beforeAll(async () => {
  h2 = http2.createServer();
  h2.on("stream", (stream, headers) => {
    const path = headers[":path"];
    if (path === "/ok") {
      stream.respond({ ":status": 200 });
      stream.end("accepted");
    } else if (path === "/cancel") {
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    // "/hang": never respond.
  });
  await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
  h2Origin = `http://127.0.0.1:${(h2.address() as AddressInfo).port}`;
  // Accepts TCP but never speaks HTTP/2: the connection preface never completes.
  silent = net.createServer((s) => sockets.add(s));
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  silentOrigin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => silent.close(() => r()));
  await new Promise<void>((r) => h2.close(() => r()));
});

describe("http2PostOnce", () => {
  it("resolves with status and body", async () => {
    await expect(http2PostOnce(h2Origin, "/ok", {}, "{}", 2000)).resolves.toEqual({ status: 200, body: "accepted" });
  });

  it("rejects when the peer never responds (overall timeout)", async () => {
    await expect(http2PostOnce(h2Origin, "/hang", {}, "{}", 200)).rejects.toThrow(/timed out/);
  });

  it("rejects when the connection never completes (connect covered by the timeout)", async () => {
    await expect(http2PostOnce(silentOrigin, "/ok", {}, "{}", 200)).rejects.toThrow(/timed out|closed/);
  });

  it("rejects instead of hanging when the stream is cancelled", async () => {
    await expect(http2PostOnce(h2Origin, "/cancel", {}, "{}", 5000)).rejects.toThrow();
  });

  it("rejects when the origin refuses the connection", async () => {
    const port = (silent.address() as AddressInfo).port;
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(deadPort).not.toBe(port);
    await expect(http2PostOnce(`http://127.0.0.1:${deadPort}`, "/ok", {}, "{}", 2000)).rejects.toThrow();
  });
});
