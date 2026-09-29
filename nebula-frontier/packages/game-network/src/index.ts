/**
 * @nebula/game-network — typed Colyseus client, snapshot interpolation,
 * client-side prediction/reconciliation (game-core stepShip), ping, reconnection
 * and portal jumps.
 */
export { Emitter } from "./emitter.js";
export { SnapshotBuffer, InterpolationBuffer, type MotionSample, type InterpolationOptions } from "./interpolation.js";
export { Reconciler, ShipPredictor, type PendingInput, type ReconcilerOptions, type ShipPredictorOptions } from "./prediction.js";
export { PingTracker } from "./clock.js";
export { GameConnection, type ConnectionEvents, type ConnectionStatus, type WorldStateView } from "./connection.js";
export {
  GameSession, ROOM_FOR_MAP_TYPE, roomForMap, type GameSessionOptions, type SessionEvents, type TicketResult, type Pose,
} from "./session.js";
