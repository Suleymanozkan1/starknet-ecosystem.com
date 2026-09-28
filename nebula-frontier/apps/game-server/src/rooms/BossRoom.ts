/**
 * World boss map (maps.json roomType "boss", e.g. Astra Graveyard). Open PvP
 * map whose world boss (4 phases, weak points, adds, enrage) is shared by all
 * pilots; collective contribution is recorded as EventParticipation and paid
 * by contribution tier (see BaseGameRoom.onBossKilled).
 */
import { RoomName, type RewardSource } from "@nebula/shared";
import { BaseGameRoom } from "./BaseGameRoom.js";

export class BossRoom extends BaseGameRoom {
  readonly roomKind = RoomName.BOSS;

  protected override requireTicketMap(): boolean {
    return true;
  }

  protected override bossRewardSource(): RewardSource {
    return "WORLD_BOSS";
  }
}
