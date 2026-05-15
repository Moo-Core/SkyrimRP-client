/**
 * End-to-end protocol test: a real WebSocket client talks to our mock
 * gateway, using the SAME framing + protobuf code path the in-game
 * transport will use. Proves the wire format round-trips before the live
 * server's :7778 endpoint exists.
 *
 * This is a node:test runner script, executed via
 *   pnpm test:skyrimrp
 * (see package.json). It exits non-zero on any assertion failure.
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { ClientHello, ClientHelloAck } from "../../src/proto/skyrimrp/v1/handshake";
import { ClientIntent, MovementIntent } from "../../src/proto/skyrimrp/v1/client_intent";
import {
  encodeFrame,
  FrameReader,
} from "../../src/services/services/skyrimRpFraming";
import { startMockGateway } from "./mockGateway";

const BUILD_ID = "skyrimrp-client-test/0.1";

/** Tiny client-side adapter that wraps a Node `ws` socket with our framing
 *  + protobuf so the test reads like the in-game flow. */
async function dial(port: number) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    sock.once("open", () => resolve());
    sock.once("error", reject);
  });
  const reader = new FrameReader();
  const inbound: Uint8Array[] = [];
  sock.on("message", (raw: Buffer) => {
    reader.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    for (;;) {
      const f = reader.next();
      if (!f) return;
      inbound.push(f);
    }
  });
  return {
    send: (bytes: Uint8Array) => sock.send(Buffer.from(encodeFrame(bytes))),
    close: () =>
      new Promise<void>((resolve) => {
        sock.once("close", () => resolve());
        sock.close();
      }),
    /** Wait until at least `n` frames have arrived, or reject after `ms`. */
    waitForFrames: async (n: number, ms: number) => {
      const deadline = Date.now() + ms;
      while (inbound.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (inbound.length < n) {
        throw new Error(
          `timeout after ${ms}ms waiting for ${n} frames (have ${inbound.length})`,
        );
      }
      return inbound.splice(0, n);
    },
  };
}

test("ClientHello round-trips through mock gateway", async () => {
  const gw = await startMockGateway();
  try {
    const cli = await dial(gw.port);
    cli.send(
      ClientHello.encode({
        protocolVersion: 1,
        sessionToken: "test-bearer-32+chars-pretend-this-is-jwt",
        claimedCharacterId: BigInt(42),
        clientBuild: BUILD_ID,
      }).finish(),
    );

    const [ackBytes] = await cli.waitForFrames(1, 2000);
    const ack = ClientHelloAck.decode(ackBytes);

    assert.equal(ack.ok, true, "handshake should succeed");
    assert.equal(ack.sessionId, BigInt(1), "first session is id=1");
    assert.equal(ack.serverProtocolVersion, 1);
    assert.equal(ack.reason, "");

    assert.equal(gw.hellos.length, 1, "gateway should have received one ClientHello");
    assert.equal(gw.hellos[0].clientBuild, BUILD_ID);
    assert.equal(gw.hellos[0].claimedCharacterId, BigInt(42));

    await cli.close();
  } finally {
    await gw.close();
  }
});

test("gateway can reject a ClientHello with a reason", async () => {
  const gw = await startMockGateway({ rejectWith: "invalid_or_expired_session" });
  try {
    const cli = await dial(gw.port);
    cli.send(
      ClientHello.encode({
        protocolVersion: 1,
        sessionToken: "stale",
        claimedCharacterId: BigInt(0),
        clientBuild: BUILD_ID,
      }).finish(),
    );
    const [ackBytes] = await cli.waitForFrames(1, 2000);
    const ack = ClientHelloAck.decode(ackBytes);
    assert.equal(ack.ok, false);
    assert.equal(ack.sessionId, BigInt(0));
    assert.equal(ack.reason, "invalid_or_expired_session");
    await cli.close();
  } finally {
    await gw.close();
  }
});

test("a stream of ClientIntents survives the framing layer", async () => {
  const gw = await startMockGateway();
  try {
    const cli = await dial(gw.port);
    cli.send(
      ClientHello.encode({
        protocolVersion: 1,
        sessionToken: "test",
        claimedCharacterId: BigInt(0),
        clientBuild: BUILD_ID,
      }).finish(),
    );
    await cli.waitForFrames(1, 2000); // discard ack

    for (let i = 1; i <= 5; i++) {
      const intent: ClientIntent = {
        sessionId: BigInt(0),
        clientSeq: BigInt(i),
        clientTsNs: BigInt(Date.now()) * BigInt(1_000_000),
        body: {
          $case: "movement",
          movement: {
            position: { x: i * 10, y: i * 20, z: i * 30 },
            rotationZ: 0.1 * i,
            velocity: { x: 1, y: 0, z: 0 },
            cellFormid: "0x3C",
            isSprinting: false,
            isSneaking: false,
            inCombat: false,
          } as MovementIntent,
        },
      };
      cli.send(ClientIntent.encode(intent).finish());
    }

    // Give the server a beat to drain the frames.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gw.intents.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(gw.intents[i].clientSeq, BigInt(i + 1));
      assert.equal(gw.intents[i].body?.$case, "movement");
      if (gw.intents[i].body?.$case === "movement") {
        const m = (gw.intents[i].body as { $case: "movement"; movement: MovementIntent })
          .movement;
        assert.equal(m.position?.x, (i + 1) * 10);
        assert.equal(m.cellFormid, "0x3C");
      }
    }
    await cli.close();
  } finally {
    await gw.close();
  }
});

test("multiple frames in a single WS message decode correctly", async () => {
  const gw = await startMockGateway();
  try {
    const cli = await dial(gw.port);
    cli.send(
      ClientHello.encode({
        protocolVersion: 1,
        sessionToken: "test",
        claimedCharacterId: BigInt(0),
        clientBuild: BUILD_ID,
      }).finish(),
    );
    await cli.waitForFrames(1, 2000);

    // Concatenate three intents into one buffer, send as a single WS frame.
    const sock = (cli as unknown as { _raw?: unknown });
    void sock; // silence unused for now; we use the underlying ws inline below.

    const parts: Buffer[] = [];
    for (let i = 1; i <= 3; i++) {
      const bytes = ClientIntent.encode({
        sessionId: BigInt(0),
        clientSeq: BigInt(i),
        clientTsNs: BigInt(0),
        body: {
          $case: "chat",
          chat: { channel: 1, text: `hello-${i}`, targetCharacter: BigInt(0) },
        },
      }).finish();
      parts.push(Buffer.from(encodeFrame(bytes)));
    }
    // Send the merged buffer through a fresh WS so we control the frame boundary.
    const direct = new WebSocket(`ws://127.0.0.1:${gw.port}`);
    await new Promise<void>((resolve, reject) => {
      direct.once("open", () => resolve());
      direct.once("error", reject);
    });
    direct.send(
      Buffer.from(
        encodeFrame(
          ClientHello.encode({
            protocolVersion: 1,
            sessionToken: "t",
            claimedCharacterId: BigInt(0),
            clientBuild: BUILD_ID,
          }).finish(),
        ),
      ),
    );
    direct.send(Buffer.concat(parts));
    await new Promise((r) => setTimeout(r, 150));

    // gw.intents accumulates across all sessions; we just need the last three
    // to be the chat messages from the merged buffer.
    const tail = gw.intents.slice(-3);
    assert.equal(tail.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(tail[i].body?.$case, "chat");
      if (tail[i].body?.$case === "chat") {
        const c = tail[i].body as { $case: "chat"; chat: { text: string } };
        assert.equal(c.chat.text, `hello-${i + 1}`);
      }
    }
    direct.close();
    await cli.close();
  } finally {
    await gw.close();
  }
});
