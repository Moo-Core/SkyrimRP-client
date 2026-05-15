#!/usr/bin/env node
/**
 * Regenerate the SkyrimRP protobuf TypeScript bindings.
 *
 * Wraps `protoc` with the ts-proto plugin so the generated code matches the
 * server's options exactly:
 *   - esModuleInterop=true  (matches webpack/tsconfig)
 *   - oneof=unions          (discriminated unions for `oneof` fields)
 *   - forceLong=bigint      (uint64/int64 → bigint, no loss of precision)
 *   - importSuffix=.js      (ESM-style import paths)
 *
 * Run from the skymp5-client/ directory:
 *   pnpm proto:gen
 *
 * Requires `protoc` 3.21+ on PATH (winget install protobuf) and the
 * `ts-proto` devDependency installed (pnpm install).
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const root = path.resolve(here, "..");
const protoRoot = path.join(root, "src", "proto");
const protoDir = path.join(protoRoot, "skyrimrp", "v1");

// Find every .proto under src/proto/.
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".proto")) out.push(p);
  }
  return out;
}
const protos = walk(protoDir);
if (protos.length === 0) {
  console.error(`no .proto files found under ${protoDir}`);
  process.exit(1);
}

// Locate ts-proto's plugin script. ts-proto ships a `bin/protoc-gen-ts_proto`
// shim that protoc invokes; pnpm hoists it to node_modules/.bin or similar.
const candidates = [
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? "protoc-gen-ts_proto.cmd" : "protoc-gen-ts_proto"),
  path.join(root, "node_modules", "ts-proto", "protoc-gen-ts_proto"),
];
const plugin = candidates.find(fs.existsSync);
if (!plugin) {
  console.error(
    "ts-proto plugin not found. Run `pnpm install` first.\nLooked at:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}

// importSuffix is empty: webpack + ts-loader resolves extensionless imports
// to the matching .ts. The server team's brief uses `.js` for ESM, but
// skymp5-client is CommonJS-under-webpack so we drop the suffix.
const opts = [
  "esModuleInterop=true",
  "oneof=unions",
  "forceLong=bigint",
  "useExactTypes=false",
  "outputServices=false",
].join(",");

console.log(`Generating TS bindings for ${protos.length} proto(s)…`);
execFileSync(
  "protoc",
  [
    `--plugin=protoc-gen-ts_proto=${plugin}`,
    `--ts_proto_out=${protoRoot}`,
    `--ts_proto_opt=${opts}`,
    `-I=${protoRoot}`,
    ...protos,
  ],
  { stdio: "inherit" },
);
console.log("OK");
