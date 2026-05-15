/**
 * Phase B — ClientIntent senders.
 *
 * Reads the local player's state on every tick and ships a
 * `ClientIntent { movement }` frame to the gateway no more often than every
 * `MOVEMENT_INTERVAL_MS`. The server reconciles all of this against
 * authoritative state — none of these values are "facts," they are requests.
 *
 * Bonus: a `sendChat(text, channel)` helper for the eventual chat overlay.
 * Inventory, equip, interact, and combat senders follow the same pattern
 * and can be added next to `sendMovementSnapshot`.
 *
 * Throttling note: 100ms = 10 Hz, comfortably under the per-message
 * MovementIntent rate limit the gateway enforces. We also suppress
 * back-to-back identical snapshots so an idle player doesn't waste bandwidth.
 */

import { Game } from "skyrimPlatform";

import { logError, logTrace } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SkyrimRpBootstrapService } from "./skyrimRpBootstrap";
import { SkyrimRpTransport } from "./skyrimRpTransport";
import {
  ChatIntent,
  ChatIntent_Channel,
  ClientIntent,
  MovementIntent,
} from "../../proto/skyrimrp/v1/client_intent";

const MOVEMENT_INTERVAL_MS = 100;

/** Skyrim returns angles in degrees; the proto contract is radians. */
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** `0x3C` style hex string for a cell/worldspace formid. Matches the
 *  `MovementIntent.cell_formid` shape. */
function formatFormId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

interface Snapshot {
  px: number;
  py: number;
  pz: number;
  rotZRad: number;
  cellId: number;
  sprinting: boolean;
  sneaking: boolean;
  inCombat: boolean;
}

export class SkyrimRpClientIntentsService extends ClientListener {
  private clientSeq = BigInt(0);
  private lastMovementSentAt = 0;
  private lastSnapshot?: Snapshot;
  private lastPos?: [number, number, number, number]; // x, y, z, ts_ms — for velocity

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("tick", () => this.onTick());
  }

  // ── Send paths ─────────────────────────────────────────────────────────

  /** Caller-driven chat send. Phase B keeps it as an exported method;
   *  Phase ?? wires it to a chat overlay's "Enter" key. */
  sendChat(text: string, channel: ChatIntent_Channel = ChatIntent_Channel.LOCAL, targetCharacter = BigInt(0)): void {
    const transport = this.transport();
    if (!transport) return;
    if (text.length === 0) return;
    const intent: ClientIntent = {
      sessionId: BigInt(0),
      clientSeq: this.nextSeq(),
      clientTsNs: BigInt(Date.now()) * BigInt(1_000_000),
      body: {
        $case: "chat",
        chat: { channel, text, targetCharacter } as ChatIntent,
      },
    };
    this.send(transport, intent);
  }

  // ── Tick loop ──────────────────────────────────────────────────────────

  private onTick(): void {
    const transport = this.transport();
    if (!transport || transport.currentState !== "established") return;

    const now = Date.now();
    if (now - this.lastMovementSentAt < MOVEMENT_INTERVAL_MS) return;

    const snap = this.readSnapshot();
    if (!snap) return;

    if (this.lastSnapshot && snapshotsEquivalent(this.lastSnapshot, snap)) {
      // Player is idle — no need to flood the gateway with identical samples.
      // We'll still ship a keepalive every ~2s once that's wanted.
      this.lastMovementSentAt = now;
      return;
    }

    const velocity = this.estimateVelocity(snap, now);
    const intent: ClientIntent = {
      sessionId: BigInt(0), // server assigns; clients always send 0
      clientSeq: this.nextSeq(),
      clientTsNs: BigInt(now) * BigInt(1_000_000),
      body: {
        $case: "movement",
        movement: {
          position: { x: snap.px, y: snap.py, z: snap.pz },
          rotationZ: snap.rotZRad,
          velocity,
          cellFormid: formatFormId(snap.cellId),
          isSprinting: snap.sprinting,
          isSneaking: snap.sneaking,
          inCombat: snap.inCombat,
        } as MovementIntent,
      },
    };

    this.send(transport, intent);
    this.lastSnapshot = snap;
    this.lastMovementSentAt = now;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private send(transport: SkyrimRpTransport, intent: ClientIntent): void {
    try {
      const bytes = ClientIntent.encode(intent).finish();
      transport.sendFrame(bytes);
    } catch (e) {
      logError("SkyrimRpClientIntents", `send failed: ${(e as Error).message}`);
    }
  }

  private nextSeq(): bigint {
    this.clientSeq += BigInt(1);
    return this.clientSeq;
  }

  /** Read everything we need from `Game.getPlayer()` in one shot, returning
   *  undefined if the player isn't loaded yet (main menu, loading screen). */
  private readSnapshot(): Snapshot | undefined {
    const player = Game.getPlayer();
    if (!player) return undefined;
    try {
      const cell = player.getParentCell();
      return {
        px: player.getPositionX(),
        py: player.getPositionY(),
        pz: player.getPositionZ(),
        rotZRad: degToRad(player.getAngleZ()),
        cellId: cell ? cell.getFormID() : 0,
        sprinting: player.isSprinting(),
        sneaking: player.isSneaking(),
        inCombat: player.isInCombat(),
      };
    } catch (e) {
      // SkyrimPlatform occasionally throws if called too early in load.
      // Swallow — we'll try again next tick.
      logTrace("SkyrimRpClientIntents", `readSnapshot failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Cheap velocity estimator from successive position samples.
   *  Server clamps anything implausible — we send our best-effort number. */
  private estimateVelocity(snap: Snapshot, nowMs: number): { x: number; y: number; z: number } {
    if (!this.lastPos) {
      this.lastPos = [snap.px, snap.py, snap.pz, nowMs];
      return { x: 0, y: 0, z: 0 };
    }
    const [lx, ly, lz, lt] = this.lastPos;
    const dt = Math.max(1, nowMs - lt) / 1000;
    const v = { x: (snap.px - lx) / dt, y: (snap.py - ly) / dt, z: (snap.pz - lz) / dt };
    this.lastPos = [snap.px, snap.py, snap.pz, nowMs];
    return v;
  }

  private transport(): SkyrimRpTransport | undefined {
    const bootstrap = this.controller.lookupListener(SkyrimRpBootstrapService);
    return bootstrap?.getTransport();
  }
}

function snapshotsEquivalent(a: Snapshot, b: Snapshot): boolean {
  const POS_EPS = 0.5; // game units
  const ROT_EPS = 0.005; // radians
  return (
    Math.abs(a.px - b.px) < POS_EPS &&
    Math.abs(a.py - b.py) < POS_EPS &&
    Math.abs(a.pz - b.pz) < POS_EPS &&
    Math.abs(a.rotZRad - b.rotZRad) < ROT_EPS &&
    a.cellId === b.cellId &&
    a.sprinting === b.sprinting &&
    a.sneaking === b.sneaking &&
    a.inCombat === b.inCombat
  );
}
