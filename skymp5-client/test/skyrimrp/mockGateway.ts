/**
 * Tiny stand-in for the real gateway, just for protocol-bridge tests.
 *
 * Speaks the same wire as `gateway/src/quic.rs` would over WebSocket:
 *   - reads 4-byte BE length prefix + protobuf body
 *   - first frame from a client is ClientHello
 *   - replies with ClientHelloAck on the same socket
 *   - subsequent frames are decoded as ClientIntent and logged
 *
 * No accounts API integration — every session_token is accepted. That's
 * fine for protocol-level tests; auth round-tripping is covered separately
 * by the accounts service's own tests.
 */

import { WebSocketServer, WebSocket } from "ws";

import { ClientHello, ClientHelloAck } from "../../src/proto/skyrimrp/v1/handshake";
import { ClientIntent } from "../../src/proto/skyrimrp/v1/client_intent";
import { encodeFrame, FrameReader } from "../../src/services/services/skyrimRpFraming";

export interface MockGatewayOptions {
  /** Listen port; 0 = pick any free port. */
  port?: number;
  /** Major proto version this mock claims to speak. Defaults to 1. */
  protocolVersion?: number;
  /** Force a rejection on ClientHello — used by negative tests. */
  rejectWith?: string;
}

export interface MockGatewayHandle {
  port: number;
  close: () => Promise<void>;
  /** Snapshot of decoded ClientHello messages received so far. */
  hellos: ClientHello[];
  /** Decoded ClientIntent stream received post-handshake. */
  intents: ClientIntent[];
}

export async function startMockGateway(
  opts: MockGatewayOptions = {},
): Promise<MockGatewayHandle> {
  const protocolVersion = opts.protocolVersion ?? 1;
  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  const hellos: ClientHello[] = [];
  const intents: ClientIntent[] = [];

  wss.on("connection", (sock: WebSocket) => {
    const reader = new FrameReader();
    let handshaken = false;
    let nextSessionId = 1;

    sock.on("message", (raw: Buffer) => {
      reader.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      for (;;) {
        const body = reader.next();
        if (!body) return;
        if (!handshaken) {
          const hello = ClientHello.decode(body);
          hellos.push(hello);
          if (opts.rejectWith) {
            sock.send(
              Buffer.from(
                encodeFrame(
                  ClientHelloAck.encode({
                    ok: false,
                    sessionId: BigInt(0),
                    reason: opts.rejectWith,
                    serverProtocolVersion: protocolVersion,
                  }).finish(),
                ),
              ),
            );
            sock.close();
            return;
          }
          const sessionId = BigInt(nextSessionId++);
          sock.send(
            Buffer.from(
              encodeFrame(
                ClientHelloAck.encode({
                  ok: true,
                  sessionId,
                  reason: "",
                  serverProtocolVersion: protocolVersion,
                }).finish(),
              ),
            ),
          );
          handshaken = true;
          continue;
        }
        // Post-handshake: everything inbound is a ClientIntent.
        try {
          intents.push(ClientIntent.decode(body));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("mockGateway: malformed ClientIntent", (e as Error).message);
        }
      }
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    hellos,
    intents,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
