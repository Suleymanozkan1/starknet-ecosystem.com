/** Round-trip latency tracking from ping/pong (EMA + jitter) and server clock offset. */
export class PingTracker {
  rtt = 0;
  jitter = 0;
  samples = 0;
  /** serverTime ≈ localNow + offset (ms). */
  offset = 0;

  sample(sentAt: number, receivedAt: number, serverTime?: number): number {
    const rtt = Math.max(0, receivedAt - sentAt);
    if (this.samples === 0) {
      this.rtt = rtt;
    } else {
      this.jitter = this.jitter * 0.85 + Math.abs(rtt - this.rtt) * 0.15;
      this.rtt = this.rtt * 0.8 + rtt * 0.2;
    }
    if (serverTime !== undefined && Number.isFinite(serverTime)) {
      const off = serverTime + rtt / 2 - receivedAt;
      this.offset = this.samples === 0 ? off : this.offset * 0.9 + off * 0.1;
    }
    this.samples++;
    return this.rtt;
  }

  get ping(): number {
    return Math.round(this.rtt);
  }
}
