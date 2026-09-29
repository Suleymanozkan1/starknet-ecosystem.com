/** Tiny Prometheus text-format registry (counters + gauges). */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  set(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(key(name, labels), value);
  }
  render(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    const emit = (map: Map<string, number>, type: string) => {
      for (const [k, v] of map) {
        const base = k.split("{")[0] as string;
        if (!typed.has(base)) {
          lines.push(`# TYPE ${base} ${type}`);
          typed.add(base);
        }
        lines.push(`${k} ${v}`);
      }
    };
    emit(this.counters, "counter");
    emit(this.gauges, "gauge");
    return lines.join("\n") + "\n";
  }
}

function key(name: string, labels: Record<string, string>): string {
  const l = Object.entries(labels);
  return l.length ? `${name}{${l.map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`).join(",")}}` : name;
}
