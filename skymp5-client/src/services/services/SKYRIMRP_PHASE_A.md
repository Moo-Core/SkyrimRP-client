# SkyrimRP — Phase A (protocol bridge)

Files added in this phase, in dependency order:

```
src/proto/skyrimrp/v1/*.proto            vendored from Moo-Core/SkyrimRP
src/proto/skyrimrp/v1/*.ts               generated; gitignored
src/proto/README.md                      regen instructions
scripts/gen-proto.cjs                    ts-proto runner
src/services/services/skyrimRpFraming.ts 4-byte BE length prefix
src/services/services/skyrimRpTransport.ts  WS + framing + ClientHello/Ack
src/services/services/skyrimRpBootstrap.ts  reads session token, dials gateway
```

Plus a one-liner registration in `src/index.ts` so the bootstrap service
is mounted alongside (not replacing) `NetworkingService`.

## What works in Phase A

- `pnpm proto:gen` produces typed encoders/decoders for the entire
  `skyrimrp.v1` namespace (ClientHello, ClientIntent, BroadcastInstruction,
  PlayerStateUpdate, etc.) using the same `ts-proto` options as the server.
- The bootstrap service:
  - reads the session token (settings entry first, then a sidecar text file
    in `Data/Platform/Plugins/skyrimrp-session.token`, then `%LOCALAPPDATA%`),
  - opens a fresh WS to the configured `server-host:server-port`,
  - sends a `ClientHello` as a length-prefixed protobuf frame,
  - awaits `ClientHelloAck`, surfacing the gateway's `session_id` on success
    or the human-readable `reason` on rejection.
- The transport's `onFrame(handler)` callback is the seam where Phase B/C
  plug in their broadcast decoders.

## Open question for the server team — broadcast payload discriminator

The proto contract has the gateway forwarding `BroadcastInstruction.payload`
to clients as opaque `bytes`. The concrete types defined in
`world_broadcast.proto` (PlayerStateUpdate, SpawnPlayer, DespawnPlayer,
ChatBroadcast, ServerStatsUpdate) have no common discriminator — they're
five disjoint message types.

The brief from the server team says:
> "On message: read length prefix, decode WorldMessage (gateway-originated)
> or specific broadcast types (PlayerStateUpdate, SpawnPlayer, …)."

That phrasing implies the client should know somehow. We don't have a way
to discriminate today. Options to confirm with them:

1. **Wrap each broadcast in `WorldMessage`** (already a oneof envelope) and
   route via the active arm. Cheapest; one extra layer of decode per frame.
2. **Add a top-level `ClientBound` envelope** with its own oneof for the
   five world-state types. Cleanest for the client; new schema.
3. **Length-prefix each payload with a small type tag byte/varint**. Compact
   but ad-hoc; less proto-native.

Until this is settled the transport just hands raw `Uint8Array` payloads to
`onFrame` handlers — Phase C will plug in once we know which type to decode.

## What Phase A explicitly does NOT do

- Send any `ClientIntent` (movement, chat, combat). That's Phase B —
  `transport.sendFrame(ClientIntent.encode(...).finish())`.
- Render other players. That's Phase C — handlers attached via
  `transport.onFrame(...)` once the broadcast discriminator above is settled.
- Anti-cheat hardening. Phase D — comes after gameplay is working.

## Verifying

```sh
# from skymp5-client/
pnpm install
pnpm proto:gen
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json \
  2>&1 | grep -E 'skyrimRp|proto[/\\]skyrimrp'   # should produce no output
```

The full skymp5-client baseline has unrelated TypeScript drift (~14 errors
in pre-existing files); none touch the SkyrimRP modules.

## Runtime smoke test (once the server's :7778 WS is up)

1. Launcher must drop a session token where the bootstrap can read it.
   Easiest: have the launcher write
   `Data/Platform/Plugins/skyrimrp-session.token` (one-line bearer).
2. Launcher must also write
   `Data/Platform/Plugins/skyrimrp-client-settings.txt` containing:
   ```json
   { "server-host": "64.44.51.18", "server-port": 7778 }
   ```
3. Start Skyrim via SKSE. The bootstrap logs `dialing SkyrimRP gateway …`
   and either `session established id=N …` or `gateway dial failed: …`.
