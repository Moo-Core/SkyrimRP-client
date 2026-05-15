/**
 * SkyrimRP transport.
 *
 * Distinct from skymp's `NetworkingService`: that one speaks JSON to skymp's
 * public server. This one speaks length-prefixed protobuf to *our* gateway
 * (currently a WebSocket on `:7778`, eventually QUIC on `:7777`).
 *
 * We use the same underlying `sp.mpClientPlugin` for the WebSocket layer so
 * we don't have to ship a separate native binding — the plugin already
 * supports `.sendRaw(buf, len, reliable)` and a `.tick(callback)` poll loop
 * with a `rawContent` branch. We just pipe its bytes through framing +
 * protobuf instead of JSON.parse.
 *
 * ## Phase A scope
 *
 * Implemented in this file:
 *   - dial(host, port)         → opens the WS via mpClientPlugin
 *   - sendHello(token, …)      → ClientHello as a length-prefixed proto frame
 *   - waitForAck()             → returns once we've seen ClientHelloAck
 *   - pump()                   → drains FrameReader on each tick; emits
 *                                'frame' events with the raw payload bytes
 *
 * Deferred (Phase B/C):
 *   - Sending ClientIntent frames (movement, chat, combat, etc.)
 *   - Decoding incoming payloads into concrete world-state messages.
 *     The current proto contract has `BroadcastInstruction.payload` as
 *     opaque `bytes` with no discriminator — needs a type tag clarified
 *     with the server team before we can wire SpawnPlayer / PlayerStateUpdate
 *     / DespawnPlayer / ChatBroadcast / ServerStatsUpdate handlers.
 */

import { logError, logTrace } from "../../logging";
import { FrameReader, encodeFrame } from "./skyrimRpFraming";
import { ClientHello, ClientHelloAck } from "../../proto/skyrimrp/v1/handshake";
import type { Sp } from "./clientListener";

export type TransportState =
  | "idle"
  | "dialing"
  | "awaiting_ack"
  | "established"
  | "failed"
  | "closed";

export interface DialOptions {
  host: string;
  port: number;
  sessionToken: string;
  protocolVersion: number;
  claimedCharacterId: bigint;
  clientBuild: string;
}

export type FrameHandler = (payload: Uint8Array) => void;

export class SkyrimRpTransport {
  private state: TransportState = "idle";
  private reader = new FrameReader();
  private ackResolve?: (ack: ClientHelloAck) => void;
  private ackReject?: (err: Error) => void;
  private frameHandlers: FrameHandler[] = [];
  private opts?: DialOptions;

  constructor(private sp: Sp) {}

  /** Open the WS and present a ClientHello.
   *  Resolves with the server's ClientHelloAck once received. */
  async dial(opts: DialOptions): Promise<ClientHelloAck> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`dial called in state ${this.state}`);
    }
    this.opts = opts;
    this.state = "dialing";
    logTrace("SkyrimRpTransport", `dialing ${opts.host}:${opts.port}`);

    // mpClientPlugin handles the WS handshake; nothing async here from JS's
    // POV. The .tick() poll loop drives both open/close events and incoming
    // frames — see `onTick()` below, which the caller must wire up.
    this.sp.mpClientPlugin.createClient(opts.host, opts.port);

    return new Promise<ClientHelloAck>((resolve, reject) => {
      this.ackResolve = resolve;
      this.ackReject = reject;
    });
  }

  /** Caller wires this into their per-tick loop (already exists in the
   *  client). We do all transport bookkeeping inside one entry point so the
   *  rest of skymp's plumbing stays untouched. */
  onTick(): void {
    this.sp.mpClientPlugin.tick((packetType: string, rawContent: unknown, error: string) => {
      switch (packetType) {
        case "connectionAccepted":
          this.handleConnectionAccepted();
          break;

        case "connectionDenied":
        case "connectionFailed":
          this.fail(`${packetType}: ${error ?? "(no detail)"}`);
          break;

        case "disconnect":
          this.handleDisconnect();
          break;

        case "message": {
          if (rawContent == null) {
            logError("SkyrimRpTransport", "tick: message with null rawContent");
            return;
          }
          // The native plugin hands us an ArrayBuffer; skymp's existing
          // networkingService also handles a JSON-vs-raw fork on the first
          // byte. Our transport speaks raw protobuf only — if we ever see
          // a JSON byte (`{`) on this connection, something's misconfigured.
          const bytes = new Uint8Array(rawContent as unknown as ArrayBuffer);
          if (bytes.byteLength > 0 && bytes[0] === 0x7b) {
            logError("SkyrimRpTransport", "tick: unexpected JSON frame on protobuf connection");
            return;
          }
          this.reader.push(bytes);
          this.drainFrames();
          break;
        }
      }
    });
  }

  /** Called when a frame arrives — whether handshake or broadcast.
   *  Splits handshake bookkeeping from "everyone else's" payload handlers. */
  private drainFrames(): void {
    let body: Uint8Array | undefined;
    while ((body = this.reader.next())) {
      if (this.state === "awaiting_ack") {
        // First frame after handshake must be ClientHelloAck.
        try {
          const ack = ClientHelloAck.decode(body);
          this.handleAck(ack);
        } catch (e) {
          this.fail(`malformed ClientHelloAck: ${(e as Error).message}`);
        }
        continue;
      }
      if (this.state === "established") {
        for (const h of this.frameHandlers) {
          try {
            h(body);
          } catch (e) {
            logError("SkyrimRpTransport", `frame handler threw: ${(e as Error).message}`);
          }
        }
        continue;
      }
      logError("SkyrimRpTransport", `dropped frame in state ${this.state} (${body.byteLength} bytes)`);
    }
  }

  /** Subscribe to incoming broadcast payloads (post-handshake).
   *  Phase B/C handlers decode these into PlayerStateUpdate, SpawnPlayer,
   *  ChatBroadcast, etc. once the payload's type tag is defined. */
  onFrame(h: FrameHandler): void {
    this.frameHandlers.push(h);
  }

  /** Send a length-prefixed protobuf frame to the gateway. Used by Phase B
   *  to ship ClientIntent — kept generic so callers don't import proto here. */
  sendFrame(bytes: Uint8Array): void {
    if (this.state !== "established") {
      throw new Error(`sendFrame called in state ${this.state}`);
    }
    const framed = encodeFrame(bytes);
    // sendRaw is the binary path on mpClientPlugin (vs .send which JSON-stringifies).
    // 2nd arg is byteLength, 3rd is reliable. Movement intents will likely
    // go unreliable; chat/inventory reliable. Phase B picks per call site.
    // mpClientPlugin types don't expose sendRaw in @skyrim-platform 2.8;
    // the C++ binding has had it for a while. @ts-ignore (not -expect-error)
    // so the build is fine whether the type ships or not.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.sp.mpClientPlugin.sendRaw(framed.buffer, framed.byteLength, true);
  }

  close(): void {
    if (this.state === "closed" || this.state === "idle") return;
    this.sp.mpClientPlugin.destroyClient();
    this.state = "closed";
  }

  get currentState(): TransportState {
    return this.state;
  }

  // ── private ────────────────────────────────────────────────────────────

  private handleConnectionAccepted(): void {
    if (this.state !== "dialing" || !this.opts) {
      logError("SkyrimRpTransport", `connectionAccepted in unexpected state ${this.state}`);
      return;
    }
    const hello = ClientHello.encode({
      protocolVersion: this.opts.protocolVersion,
      sessionToken: this.opts.sessionToken,
      claimedCharacterId: this.opts.claimedCharacterId,
      clientBuild: this.opts.clientBuild,
    }).finish();
    const framed = encodeFrame(hello);
    this.state = "awaiting_ack";
    logTrace("SkyrimRpTransport", `WS open — sending ClientHello (${hello.byteLength}B)`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — see sendFrame note for the sendRaw type gap.
    this.sp.mpClientPlugin.sendRaw(framed.buffer, framed.byteLength, true);
  }

  private handleAck(ack: ClientHelloAck): void {
    if (!ack.ok) {
      this.fail(
        `gateway rejected ClientHello: ${ack.reason || "(no reason)"}` +
          ` (server proto v${ack.serverProtocolVersion})`,
      );
      return;
    }
    this.state = "established";
    logTrace(
      "SkyrimRpTransport",
      `session established id=${ack.sessionId} server-proto=v${ack.serverProtocolVersion}`,
    );
    this.ackResolve?.(ack);
    this.ackResolve = undefined;
    this.ackReject = undefined;
  }

  private handleDisconnect(): void {
    if (this.state === "established") {
      logTrace("SkyrimRpTransport", "session closed by gateway");
      this.state = "closed";
      return;
    }
    if (this.ackReject) {
      this.fail("disconnected before ClientHelloAck");
    } else {
      this.state = "closed";
    }
  }

  private fail(reason: string): void {
    logError("SkyrimRpTransport", `transport failed: ${reason}`);
    this.state = "failed";
    this.ackReject?.(new Error(reason));
    this.ackResolve = undefined;
    this.ackReject = undefined;
  }
}
