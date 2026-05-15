/**
 * Phase C scaffold — remote-actor lifecycle.
 *
 * Subscribes to the broadcast router and maps `session_id` → a Skyrim
 * `Actor` refid. Implements:
 *   SpawnPlayer        → load (placeholder: pick a generic NPC base form;
 *                        future: apply `appearance` racemenu blob)
 *   DespawnPlayer      → unload + drop the mapping
 *   PlayerStateUpdate  → lerp the actor's position toward the new target
 *                        over ~100ms (matches the broadcast cadence)
 *   ServerStatsUpdate  → set the actor's health/stamina/magicka; for the
 *                        local player, reconcile the HUD if it diverges
 *   ChatBroadcast      → forward to the chat overlay (TODO: overlay)
 *
 * Where this is honest about being a scaffold:
 *   - `placeWeightedActor()` uses a vanilla NPC base form id (Bandit) until
 *     we have a way to spawn a fresh Actor with a custom appearance blob.
 *     SkyrimPlatform exposes `Game.placeWeightedAttack...` and there are
 *     skymp utilities for this — we'll wire those in once the contract
 *     question is settled.
 *   - The local player's session_id needs server confirmation (ClientHelloAck
 *     gives us one but we also need to know which broadcasts apply to "us"
 *     so we can skip rendering a duplicate). Stored from the ack today,
 *     used when the lerp handler decides to apply or skip a position.
 */

import { Actor, Game, ObjectReference, TESModPlatform } from "skyrimPlatform";

import { logError, logTrace } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SkyrimRpBootstrapService } from "./skyrimRpBootstrap";
import { SkyrimRpBroadcastRouter, DecodedBroadcast } from "./skyrimRpBroadcastRouter";

/** Base form for the placeholder remote-player actor. Vanilla Bandit
 *  (0x000133BC) — humanoid, sane skeleton, easy to spawn. */
const PLACEHOLDER_BASE_FORM_ID = 0x000133bc;

interface RemoteActor {
  sessionId: bigint;
  characterId: bigint;
  /** Skyrim ref form id of the spawned actor. 0 = not yet placed. */
  refId: number;
  /** Last position we received, used as the lerp target. */
  target: { x: number; y: number; z: number; rotZRad: number; ts: number };
}

export class SkyrimRpRemoteActorsService extends ClientListener {
  private remotes = new Map<string, RemoteActor>();
  private router?: SkyrimRpBroadcastRouter;
  private localSessionId: bigint = BigInt(0);

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    // Hook in after all services are wired so the bootstrap exists.
    this.controller.once("update", () => this.attach());
    this.controller.on("tick", () => this.onTick());
  }

  /** Bootstrap calls this with the session_id from ClientHelloAck so we
   *  don't render an extra body where the local player is standing. */
  setLocalSessionId(id: bigint): void {
    this.localSessionId = id;
  }

  // ── attachment ─────────────────────────────────────────────────────────

  private attach(): void {
    const bootstrap = this.controller.lookupListener(SkyrimRpBootstrapService);
    if (!bootstrap) {
      logError("SkyrimRpRemoteActors", "no SkyrimRpBootstrapService — disabled");
      return;
    }
    const transport = bootstrap.getTransport();
    this.router = new SkyrimRpBroadcastRouter();
    this.router.on((b) => this.handle(b));
    transport.onFrame((bytes) => this.router?.ingest(bytes));
    logTrace("SkyrimRpRemoteActors", "attached to transport.onFrame");
  }

  // ── broadcast handler ──────────────────────────────────────────────────

  private handle(b: DecodedBroadcast): void {
    switch (b.kind) {
      case "spawnPlayer":
        this.onSpawn(b.msg.sessionId, b.msg.characterId, b.msg.position?.x ?? 0, b.msg.position?.y ?? 0, b.msg.position?.z ?? 0, b.msg.rotationZ);
        break;
      case "despawnPlayer":
        this.onDespawn(b.msg.sessionId);
        break;
      case "playerStateUpdate":
        if (b.msg.sessionId === this.localSessionId) return;
        this.onMove(b.msg.sessionId, b.msg.position?.x ?? 0, b.msg.position?.y ?? 0, b.msg.position?.z ?? 0, b.msg.rotationZ);
        break;
      case "chatBroadcast":
        logTrace(
          "SkyrimRpRemoteActors",
          `chat [ch=${b.msg.channel}] ${b.msg.fromName}: ${b.msg.text}`,
        );
        // TODO: forward to a chat overlay service when that exists.
        break;
      case "serverStatsUpdate":
        // TODO: drive a floating health bar over remote actors,
        // and reconcile the local HUD if msg.sessionId === localSessionId.
        break;
      case "unknown":
        logTrace(
          "SkyrimRpRemoteActors",
          `unrouted frame (${b.bytes.byteLength}B): ${b.reason}`,
        );
        break;
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  private onSpawn(
    sessionId: bigint,
    characterId: bigint,
    x: number,
    y: number,
    z: number,
    rotZRad: number,
  ): void {
    if (sessionId === this.localSessionId) {
      // The server may "spawn" us as a confirmation; nothing to render.
      return;
    }
    const key = sessionId.toString();
    if (this.remotes.has(key)) return;
    const refId = this.placePlaceholderActor(x, y, z, rotZRad);
    this.remotes.set(key, {
      sessionId,
      characterId,
      refId,
      target: { x, y, z, rotZRad, ts: Date.now() },
    });
    logTrace(
      "SkyrimRpRemoteActors",
      `spawn s=${sessionId} c=${characterId} → ref ${refId.toString(16)}`,
    );
  }

  private onDespawn(sessionId: bigint): void {
    const key = sessionId.toString();
    const r = this.remotes.get(key);
    if (!r) return;
    this.unplaceActor(r.refId);
    this.remotes.delete(key);
    logTrace("SkyrimRpRemoteActors", `despawn s=${sessionId}`);
  }

  private onMove(
    sessionId: bigint,
    x: number,
    y: number,
    z: number,
    rotZRad: number,
  ): void {
    const r = this.remotes.get(sessionId.toString());
    if (!r) return;
    r.target = { x, y, z, rotZRad, ts: Date.now() };
  }

  // ── per-tick lerp ──────────────────────────────────────────────────────

  private onTick(): void {
    if (this.remotes.size === 0) return;
    const now = Date.now();
    for (const r of this.remotes.values()) {
      if (r.refId === 0) continue;
      const ref = ObjectReference.from(Game.getFormEx(r.refId));
      if (!ref) continue;
      // Cheap: snap to the latest target if we're already close, otherwise
      // ease toward it over ~100ms (matches MovementIntent cadence).
      const t = r.target;
      const ageMs = now - t.ts;
      const ease = Math.min(1, ageMs / 100);
      try {
        const cx = ref.getPositionX();
        const cy = ref.getPositionY();
        const cz = ref.getPositionZ();
        ref.setPosition(
          cx + (t.x - cx) * ease,
          cy + (t.y - cy) * ease,
          cz + (t.z - cz) * ease,
        );
      } catch {
        // setPosition can throw if the cell isn't loaded; we'll catch up next tick.
      }
    }
  }

  // ── placeholder placement ──────────────────────────────────────────────

  /** Spawn a placeholder Actor at the given coords. Returns its formid (or
   *  0 if placement failed). Will be replaced with a real custom-appearance
   *  spawn once skymp's actor-creation utility is borrowed/refactored. */
  private placePlaceholderActor(x: number, y: number, z: number, rotZRad: number): number {
    try {
      const player = Game.getPlayer();
      if (!player) return 0;
      const baseForm = Game.getFormEx(PLACEHOLDER_BASE_FORM_ID);
      if (!baseForm) {
        logError(
          "SkyrimRpRemoteActors",
          `placeholder base form ${PLACEHOLDER_BASE_FORM_ID.toString(16)} not found — load order mismatch?`,
        );
        return 0;
      }
      // PlaceAtMe spawns near the player; we'll setPosition immediately
      // after to get the right spot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const placed = (TESModPlatform as any).placeAtMe?.(player, baseForm, 1, true, false);
      const actor = placed ? Actor.from(placed) : undefined;
      if (!actor) return 0;
      actor.setPosition(x, y, z);
      actor.setAngle(0, 0, (rotZRad * 180) / Math.PI);
      return actor.getFormID();
    } catch (e) {
      logError("SkyrimRpRemoteActors", `placePlaceholderActor: ${(e as Error).message}`);
      return 0;
    }
  }

  private unplaceActor(refId: number): void {
    if (refId === 0) return;
    try {
      const ref = ObjectReference.from(Game.getFormEx(refId));
      if (ref) {
        // `disable` hides; `delete` removes from the world entirely.
        ref.disable(false);
        ref.delete();
      }
    } catch (e) {
      logError("SkyrimRpRemoteActors", `unplaceActor: ${(e as Error).message}`);
    }
  }
}
