/** Open-world map (maps.json roomType "sector"): NPC spawns, mining, stations, portals, faction PvP zones. */
import { RoomName } from "@nebula/shared";
import { BaseGameRoom } from "./BaseGameRoom.js";

export class SectorRoom extends BaseGameRoom {
  readonly roomKind = RoomName.SECTOR;

  /** Tickets are issued for a specific map (last position / portal target). */
  protected override requireTicketMap(): boolean {
    return true;
  }
}
