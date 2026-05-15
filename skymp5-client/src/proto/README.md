# SkyrimRP protobuf bindings

The `.proto` files under `skyrimrp/v1/` are vendored copies of the server's
contract at `Moo-Core/SkyrimRP/proto/skyrimrp/v1/`. They are the source of
truth — every wire message the client sends or receives must match these.

## Regenerate the TypeScript bindings

```sh
pnpm install        # one-time, pulls in ts-proto
pnpm proto:gen      # runs scripts/gen-proto.cjs → writes *.ts next to *.proto
```

Generated `.ts` files are gitignored; only the `.proto` source is committed.

## Updating from the server

When the server publishes a new contract version, copy the new `.proto`
files over the ones here and regenerate. The package name (`skyrimrp.v1`)
moves to `.v2` on a breaking change.

## ts-proto options

We match the server's generation options exactly so the wire bytes round-trip:

- `oneof=unions` — discriminated unions for `oneof` fields (closest TS analog).
- `forceLong=bigint` — `uint64`/`int64` become `bigint` (no precision loss).
- `esModuleInterop=true`, `importSuffix=.js` — matches the webpack/tsconfig
  setup of skymp5-client.
- `outputServices=false` — protobuf only, no gRPC stubs (we don't use gRPC).
