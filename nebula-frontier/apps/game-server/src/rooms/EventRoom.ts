/**
 * Instanced event arena: hosts an ACTIVE event (events.json) on one of its
 * maps. Joining requires the event to be running; the event boss spawns via
 * the event engine and contribution tiers pay out on kill.
 */
import { NPCS_BY_ID } from "@nebula/config";
import { RoomName, type RewardSource } from "@nebula/shared";
import { ServerError } from "@colyseus/core";
import { BaseGameRoom } from "./BaseGameRoom.js";
import type { PlayerActor } from "./actors.js";
import type { ActiveEvent } from "../services/events.js";

export class EventRoom extends BaseGameRoom {
  readonly roomKind = RoomName.EVENT;

  /** Portal/rift jumps issue a ticket for exactly this map; a ticket for another map must not enter. */
  protected override requireTicketMap(): boolean {
    return true;
  }

  protected override setupWorld(): void {
    // Event instances only contain event spawns (boss via onEventStarted) + asteroids.
    this.spawnAsteroids();
  }

  protected override async beforePlayerJoin(_p: PlayerActor): Promise<void> {
    if (this.svc.events.activeFor(this.map.id).length === 0) throw new ServerError(4403, "NO_ACTIVE_EVENT");
  }

  protected override onEventStarted(a: ActiveEvent): void {
    super.onEventStarted(a);
    // Invasion-style events without a boss spawn waves of the map's regular NPCs.
    if (!a.def.boss && a.def.type === "INVASION") {
      for (const s of this.map.spawns) {
        const def = NPCS_BY_ID.get(s.npcId);
        if (!def) continue;
        for (let i = 0; i < s.count; i++) this.spawnNpc(def, s.x + (this.rng() - 0.5) * s.radius, s.y + (this.rng() - 0.5) * s.radius, { spawnIndex: null, homeRadius: s.radius, tag: `event:${a.def.id}:${a.window.start}` });
      }
    }
  }

  protected override bossRewardSource(): RewardSource {
    return "EVENT";
  }
}
