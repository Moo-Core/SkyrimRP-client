/**
 * Phase C scaffold — broadcast frame router.
 *
 * The transport hands every post-handshake frame to this router via
 * `onFrame(bytes)`. We then need to decode `bytes` into one of:
 *   - PlayerStateUpdate
 *   - SpawnPlayer
 *   - DespawnPlayer
 *   - ChatBroadcast
 *   - ServerStatsUpdate
 *
 * The CURRENT proto contract has the gateway forwarding
 * `BroadcastInstruction.payload` as opaque bytes with no discriminator
 * (see SKYRIMRP_PHASE_A.md "Open question for the server team"). Until the
 * server team picks a strategy, this module exposes the seam and emits a
 * `raw` event with the bytes; we'll flip one function (`decodeFrame`) once
 * the discriminator scheme is settled.
 *
 * Three likely outcomes, all supportable from here:
 *   1. WorldMessage wrapper             → swap `decodeFrame` to call
 *                                         WorldMessage.decode().
 *   2. New ClientBound oneof envelope   → same idea, different type.
 *   3. Type-tag varint prefix on payload → strip leading varint, pick a
 *                                         type-id → decode that body.
 *
 * Default behaviour today is a best-effort try-decode in priority order so
 * Phase C smoke-testing can happen the moment the server's :7778 lands.
 * The first message a server sends a brand-new client is almost always
 * SpawnPlayer (for the local player), then PlayerStateUpdate fanout, then
 * ChatBroadcast/ServerStatsUpdate. We try in that order; on mismatch the
 * caller is told `unknown` and can decide whether to drop or log.
 */

import { logError, logTrace } from "../../logging";
import {
  ChatBroadcast,
  DespawnPlayer,
  PlayerStateUpdate,
  ServerStatsUpdate,
  SpawnPlayer,
} from "../../proto/skyrimrp/v1/world_broadcast";

export type DecodedBroadcast =
  | { kind: "spawnPlayer"; msg: SpawnPlayer }
  | { kind: "despawnPlayer"; msg: DespawnPlayer }
  | { kind: "playerStateUpdate"; msg: PlayerStateUpdate }
  | { kind: "chatBroadcast"; msg: ChatBroadcast }
  | { kind: "serverStatsUpdate"; msg: ServerStatsUpdate }
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

  /**
   * STRATEGY POINT — this is the one function to rewrite once the server
   * team confirms the discriminator. Current implementation tries each
   * concrete type in plausibility order. False positives are POSSIBLE
   * with very small protobufs (different types can share field-number
   * layouts when only a few fields are set), so this is *interim only*.
   */
  private decodeFrame(bytes: Uint8Array): DecodedBroadcast {
    // Priority order = "most frequent broadcast first". A real
    // discriminator will replace this when ready.
    for (const attempt of [
      () => ({ kind: "playerStateUpdate" as const, msg: PlayerStateUpdate.decode(bytes) }),
      () => ({ kind: "spawnPlayer" as const, msg: SpawnPlayer.decode(bytes) }),
      () => ({ kind: "despawnPlayer" as const, msg: DespawnPlayer.decode(bytes) }),
      () => ({ kind: "chatBroadcast" as const, msg: ChatBroadcast.decode(bytes) }),
      () => ({ kind: "serverStatsUpdate" as const, msg: ServerStatsUpdate.decode(bytes) }),
    ]) {
      try {
        const result = attempt();
        // Cheap sanity: every world-state message carries world_ts_ns at
        // field 5/9/10/11 depending on type, and a session_id/character_id
        // pair at 1/2. If both are zero we *probably* mis-decoded.
        if (looksPlausible(result)) return result;
      } catch {
        // try the next
      }
    }
    return {
      kind: "unknown",
      bytes,
      reason: `no decoder matched (${bytes.byteLength} bytes)`,
    };
  }
}

function looksPlausible(d: DecodedBroadcast): boolean {
  switch (d.kind) {
    case "playerStateUpdate":
      return d.msg.sessionId !== BigInt(0) || d.msg.worldTsNs !== BigInt(0);
    case "spawnPlayer":
      return d.msg.sessionId !== BigInt(0) || d.msg.characterId !== BigInt(0);
    case "despawnPlayer":
      return d.msg.sessionId !== BigInt(0) || d.msg.characterId !== BigInt(0);
    case "chatBroadcast":
      return d.msg.text.length > 0 || d.msg.fromCharacter !== BigInt(0);
    case "serverStatsUpdate":
      return d.msg.sessionId !== BigInt(0) || d.msg.characterId !== BigInt(0);
    default:
      return false;
  }
}
