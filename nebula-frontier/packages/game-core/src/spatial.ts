/**
 * Uniform-grid spatial hash for neighbour queries (area of interest, splash,
 * NPC perception). Rebuilt per tick — O(n) insert, O(k) query.
 */
export interface Positioned { id: string; x: number; y: number }

export class SpatialGrid<T extends Positioned> {
  private cells = new Map<number, T[]>();
  readonly cellSize: number;
  constructor(cellSize: number) {
    this.cellSize = Math.max(1, cellSize);
  }
  private key(cx: number, cy: number): number {
    // Supports maps up to ±32k cells per axis.
    return (cx + 32768) * 65536 + (cy + 32768);
  }
  clear(): void {
    this.cells.clear();
  }
  insert(item: T): void {
    const k = this.key(Math.floor(item.x / this.cellSize), Math.floor(item.y / this.cellSize));
    const arr = this.cells.get(k);
    if (arr) arr.push(item);
    else this.cells.set(k, [item]);
  }
  rebuild(items: Iterable<T>): void {
    this.clear();
    for (const it of items) this.insert(it);
  }
  /** Items within `radius` of (x, y). */
  query(x: number, y: number, radius: number, out: T[] = []): T[] {
    const r2 = radius * radius;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const arr = this.cells.get(this.key(cx, cy));
        if (!arr) continue;
        for (const it of arr) {
          const dx = it.x - x;
          const dy = it.y - y;
          if (dx * dx + dy * dy <= r2) out.push(it);
        }
      }
    }
    return out;
  }
}
