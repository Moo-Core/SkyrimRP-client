/**
 * Broadcast frame router.
 *
 * Server-side decided (SkyrimRP commit af91295): every length-prefixed
 * frame the gateway sends a client post-handshake is a `WorldStateBroadcast`
 * envelope. The router decodes it once and dispatches on `body.$case` —
 * no more try-decode heuristics.
 */

import { logError } from "../../logging";
import {
  ChatBroadcast,
  DespawnPlayer,
  PlayerStateUpdate,
  ServerStatsUpdate,
  SpawnPlayer,
  WorldStateBroadcast,
} from "../../proto/skyrimrp/v1/world_broadcast";

export type DecodedBroadcast =
  | { kind: "spawnPlayer"; msg: SpawnPlayer }
  | { kind: "despawnPlayer"; msg: DespawnPlayer }
  | { kind: "playerStateUpdate"; msg: PlayerStateUpdate }
  | { kind: "chatBroadcast"; msg: ChatBroadcast }
  | { kind: "serverStatsUpdate"; msg: ServerStatsUpdate }
  | { kind: "empty" }
  | { kind: "unknown"; bytes: Uint8Array; reason: string };

type Handler = (b: DecodedBroadcast) => void;

export class SkyrimRpBroadcastRouter {
  private handlers: Handler[] = [];

  on(h: Handler): void {
    this.handlers.push(h);
  }

  /** Pass each frame from `transport.onFrame(...)` through here. */
  ingest(bytes: Uint8Array): void {
    const decoded = this.decodeFrame(bytes);
    for (const h of this.handlers) {
      try {
        h(decoded);
      } catch (e) {
        logError(
          "SkyrimRpBroadcastRouter",
          `handler threw on ${decoded.kind}: ${(e as Error).message}`,
        );
      }
    }
  }

  private decodeFrame(bytes: Uint8Array): DecodedBroadcast {
    let env: WorldStateBroadcast;
    try {
      env = WorldStateBroadcast.decode(bytes);
    } catch (e) {
      return {
        kind: "unknown",
        bytes,
        reason: `WorldStateBroadcast.decode failed: ${(e as Error).message}`,
      };
    }
    const body = env.body;
    if (!body) return { kind: "empty" };
    switch (body.$case) {
      case "playerState":
        return { kind: "playerStateUpdate", msg: body.playerState };
      case "spawn":
        return { kind: "spawnPlayer", msg: body.spawn };
      case "despawn":
        return { kind: "despawnPlayer", msg: body.despawn };
      case "chat":
        return { kind: "chatBroadcast", msg: body.chat };
      case "stats":
        return { kind: "serverStatsUpdate", msg: body.stats };
    }
  }
}
