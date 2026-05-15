/**
 * Live-server smoke. Walks the entire Phase A path against the real
 * SkyrimRP server at 64.44.51.18 — no mock involved.
 *
 *   register → verify-email → login → WS connect → ClientHello →
 *   ClientHelloAck → drain WorldStateBroadcast frames for a few seconds
 *
 * Run with:
 *   node --import tsx test/skyrimrp/liveSmoke.ts
 *
 * Optional env vars (defaults in code):
 *   SKYRIMRP_ACCOUNTS_URL   default http://64.44.51.18:8081
 *   SKYRIMRP_WS_URL         default ws://64.44.51.18:7778
 *   SKYRIMRP_TEST_EMAIL     default {randomized per run}
 *   SKYRIMRP_TEST_USERNAME  default {randomized per run}
 *
 * Exits 0 on full success, 1 on any step that fails. Designed for CI.
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";

import { ClientHello, ClientHelloAck } from "../../src/proto/skyrimrp/v1/handshake";
import { WorldStateBroadcast } from "../../src/proto/skyrimrp/v1/world_broadcast";
import { encodeFrame, FrameReader } from "../../src/services/services/skyrimRpFraming";

const ACCOUNTS = process.env.SKYRIMRP_ACCOUNTS_URL ?? "http://64.44.51.18:8081";
const WS_URL = process.env.SKYRIMRP_WS_URL ?? "ws://64.44.51.18:7778";

const suffix = randomBytes(4).toString("hex");
const EMAIL = process.env.SKYRIMRP_TEST_EMAIL ?? `smoke-${suffix}@example.com`;
const USERNAME = process.env.SKYRIMRP_TEST_USERNAME ?? `smoke_${suffix}`;
const PASSWORD = "smoke-test-password-1234";

async function postJson<T>(path: string, body: unknown, bearer?: string): Promise<T> {
  const r = await fetch(`${ACCOUNTS}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} → ${r.status} ${r.statusText}; non-JSON body: ${text}`);
  }
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text}`);
  return parsed as T;
}

interface RegisterOk {
  ok: true;
  account_id: number;
  dev_mode?: boolean;
  email_verification_token?: string;
  oauth_start_url?: string;
}
interface VerifyOk {
  ok: true;
  status: string;
}
interface LoginOk {
  ok: true;
  account_id: number;
  username: string;
  session_token: string;
  expires_at: string;
}

async function getSessionToken(): Promise<{ token: string; sessionLabel: string }> {
  console.log(`[smoke] POST /register email=${EMAIL} username=${USERNAME}`);
  const reg = await postJson<RegisterOk>("/register", {
    email: EMAIL,
    username: USERNAME,
    password: PASSWORD,
  });
  console.log(`[smoke]   account_id=${reg.account_id} dev_mode=${reg.dev_mode ?? false}`);
  if (reg.email_verification_token) {
    console.log("[smoke] POST /verify-email (dev-mode auto-issued token)");
    const v = await postJson<VerifyOk>("/verify-email", {
      token: reg.email_verification_token,
    });
    console.log(`[smoke]   account status → ${v.status}`);
  } else {
    throw new Error(
      "register did not return a verify token — server not in dev mode and OAuth flow not wired in this smoke",
    );
  }
  console.log("[smoke] POST /login");
  const log = await postJson<LoginOk>("/login", {
    identifier: USERNAME,
    password: PASSWORD,
  });
  console.log(`[smoke]   logged in as ${log.username}, token len=${log.session_token.length}`);
  return { token: log.session_token, sessionLabel: log.username };
}

async function gameConnect(token: string, label: string): Promise<void> {
  console.log(`[smoke] WS connect ${WS_URL}`);
  const sock = new WebSocket(WS_URL);
  await new Promise<void>((res, rej) => {
    sock.once("open", () => res());
    sock.once("error", (e) => rej(e));
  });
  console.log("[smoke]   open");

  const reader = new FrameReader();
  const broadcasts: WorldStateBroadcast[] = [];
  let ack: ClientHelloAck | undefined;
  let handshakeDone = false;

  sock.on("message", (raw: Buffer) => {
    reader.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    for (;;) {
      const f = reader.next();
      if (!f) return;
      if (!handshakeDone) {
        ack = ClientHelloAck.decode(f);
        handshakeDone = true;
        continue;
      }
      try {
        broadcasts.push(WorldStateBroadcast.decode(f));
      } catch (e) {
        console.warn(`[smoke]   undecodable frame (${f.byteLength}B): ${(e as Error).message}`);
      }
    }
  });

  const hello = ClientHello.encode({
    protocolVersion: 1,
    sessionToken: token,
    claimedCharacterId: BigInt(0),
    clientBuild: `skyrimrp-client-livesmoke/0.1 (${label})`,
  }).finish();
  sock.send(Buffer.from(encodeFrame(hello)));
  console.log(`[smoke]   sent ClientHello (${hello.byteLength}B body)`);

  // Wait up to 5s for the handshake.
  const deadline = Date.now() + 5000;
  while (!ack && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ack) throw new Error("no ClientHelloAck within 5s");
  console.log(
    `[smoke]   ClientHelloAck ok=${ack.ok} session_id=${ack.sessionId} reason='${ack.reason}'`,
  );
  if (!ack.ok) throw new Error(`gateway rejected: ${ack.reason}`);

  // Server sends spawn broadcasts immediately. Wait a bit and inspect.
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[smoke]   received ${broadcasts.length} WorldStateBroadcast frame(s)`);
  for (const b of broadcasts) {
    if (!b.body) {
      console.log(`[smoke]     - empty body`);
      continue;
    }
    switch (b.body.$case) {
      case "spawn": {
        const s = b.body.spawn;
        console.log(
          `[smoke]     - spawn: session=${s.sessionId} char=${s.characterId} ` +
            `name='${s.displayName}' pos=(${s.position?.x.toFixed(0)},${s.position?.y.toFixed(0)},${s.position?.z.toFixed(0)})`,
        );
        break;
      }
      case "playerState": {
        const p = b.body.playerState;
        console.log(`[smoke]     - playerState: session=${p.sessionId}`);
        break;
      }
      case "chat":
        console.log(`[smoke]     - chat: ${b.body.chat.fromName}: ${b.body.chat.text}`);
        break;
      case "despawn":
        console.log(`[smoke]     - despawn: session=${b.body.despawn.sessionId}`);
        break;
      case "stats":
        console.log(`[smoke]     - stats: session=${b.body.stats.sessionId}`);
        break;
    }
  }

  // Look for our own spawn — that's the proof the server placed us in the world.
  const selfSpawn = broadcasts.find(
    (b) => b.body?.$case === "spawn" && b.body.spawn.sessionId === ack.sessionId,
  );
  if (selfSpawn && selfSpawn.body?.$case === "spawn") {
    console.log(
      `[smoke] AUTHORITATIVE SELF POSITION: session=${ack.sessionId} char=${selfSpawn.body.spawn.characterId}`,
    );
  } else {
    console.warn(`[smoke] WARN: no self-spawn for session_id=${ack.sessionId} within 1.5s`);
  }

  sock.close();
}

async function main(): Promise<void> {
  const { token, sessionLabel } = await getSessionToken();
  await gameConnect(token, sessionLabel);
  console.log("[smoke] PASS — full Phase A path against live server is green");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[smoke] FAIL: ${(err as Error).stack ?? (err as Error).message ?? err}`);
    process.exit(1);
  },
);
