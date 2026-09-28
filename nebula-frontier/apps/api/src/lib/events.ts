/** Event definitions: config events.json overlaid with admin-managed Event rows (disabled rows hidden). */
import { EVENTS } from "@nebula/config";
import type { DbOrTx } from "@nebula/database";
import type { EventDef } from "@nebula/shared";
import { asRecord } from "./json.js";

export async function loadEventDefs(db: DbOrTx): Promise<EventDef[]> {
  const rows = await db.event.findMany();
  const defs = new Map<string, EventDef & { enabled: boolean }>();
  for (const e of EVENTS) defs.set(e.id, { ...e, enabled: true });
  for (const r of rows) {
    const base = defs.get(r.id) ?? (asRecord(r.data) as unknown as EventDef);
    defs.set(r.id, {
      ...base, ...(asRecord(r.data) as Partial<EventDef>), id: r.id, name: r.name, type: r.type as EventDef["type"],
      startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), enabled: r.active,
    });
  }
  return [...defs.values()].filter((d) => d.enabled).map(({ enabled: _e, ...d }) => d);
}
