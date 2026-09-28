/** Minimal typed event emitter (no allocation on emit). */
export class Emitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, cb: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb as (payload: never) => void);
    return () => {
      set?.delete(cb as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`[game-network] handler for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
