/**
 * Single-file proof of wire-format correctness — no test framework, just
 * runs the round-trip and prints PASS/FAIL. Exit code 0 on success.
 *
 *   node --import tsx test/skyrimrp/smoke.ts
 */

import WebSocket from "ws";

import { ClientHello, ClientHelloAck } from "../../src/proto/skyrimrp/v1/handshake";
import { ClientIntent, MovementIntent } from "../../src/proto/skyrimrp/v1/client_intent";
import { encodeFrame, FrameReader } from "../../src/services/services/skyrimRpFraming";
import { startMockGateway } from "./mockGateway";

async function main(): Promise<void> {
  console.log("[smoke] starting mock gateway…");
  const gw = await startMockGateway();
  console.log(`[smoke] mock gateway on :${gw.port}`);

  const sock = new WebSocket(`ws://127.0.0.1:${gw.port}`);
  await new Promise<void>((res, rej) => {
    sock.once("open", () => res());
    sock.once("error", rej);
  });
  console.log("[smoke] connected");

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

  // 1. ClientHello
  const helloBytes = ClientHello.encode({
    protocolVersion: 1,
    sessionToken: "test-bearer-32+chars-pretend-this-is-jwt",
    claimedCharacterId: BigInt(42),
    clientBuild: "skyrimrp-client-smoke/0.1",
  }).finish();
  sock.send(Buffer.from(encodeFrame(helloBytes)));
  console.log(`[smoke] sent ClientHello (${helloBytes.byteLength}B body)`);

  // 2. Wait for ClientHelloAck.
  const ackBytes = await waitForFrame(inbound, 2000);
  const ack = ClientHelloAck.decode(ackBytes);
  console.log(
    `[smoke] received ClientHelloAck ok=${ack.ok} session_id=${ack.sessionId} reason='${ack.reason}'`,
  );
  if (!ack.ok) throw new Error("handshake rejected");
  if (ack.sessionId !== BigInt(1)) throw new Error("expected session_id=1");

  // 3. Send a few movement intents.
  for (let i = 1; i <= 3; i++) {
    const intent: ClientIntent = {
      sessionId: BigInt(0),
      clientSeq: BigInt(i),
      clientTsNs: BigInt(Date.now()) * BigInt(1_000_000),
      body: {
        $case: "movement",
        movement: {
          position: { x: i * 100, y: 0, z: 0 },
          rotationZ: 0,
          velocity: { x: 0, y: 0, z: 0 },
          cellFormid: "0x3C",
          isSprinting: false,
          isSneaking: false,
          inCombat: false,
        } as MovementIntent,
      },
    };
    sock.send(Buffer.from(encodeFrame(ClientIntent.encode(intent).finish())));
  }
  await new Promise((r) => setTimeout(r, 200));

  // Server should have decoded all three.
  if (gw.intents.length !== 3) {
    throw new Error(`gateway received ${gw.intents.length} intents, expected 3`);
  }
  for (let i = 0; i < 3; i++) {
    if (gw.intents[i].clientSeq !== BigInt(i + 1)) {
      throw new Error(`intent[${i}] clientSeq=${gw.intents[i].clientSeq} expected ${i + 1}`);
    }
  }
  console.log(`[smoke] gateway decoded ${gw.intents.length} ClientIntents — seqs OK`);

  sock.close();
  await gw.close();
  console.log("[smoke] PASS");
}

async function waitForFrame(inbound: Uint8Array[], timeoutMs: number): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  while (inbound.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const f = inbound.shift();
  if (!f) throw new Error(`timeout after ${timeoutMs}ms waiting for frame`);
  return f;
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[smoke] FAIL: ${err.stack || err.message || err}`);
    process.exit(1);
  },
);
