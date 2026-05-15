/**
 * SkyrimRP bootstrap.
 *
 * Reads the session token the launcher dropped into
 * `%LOCALAPPDATA%\SkyrimRP\session.token`, dials the gateway, and presents
 * a ClientHello. Runs once on game-load; if the file is missing, the user
 * is signing in offline (vanilla Skyrim) and we no-op.
 *
 * Wired into the existing service framework so it lifecycles cleanly with
 * the rest of skymp's plumbing. See `services/services/clientListener.ts`
 * for the pattern.
 */

import { logError, logTrace } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SkyrimRpTransport } from "./skyrimRpTransport";

/** Wire-protocol version this client speaks. Must equal the server's
 *  `expected_protocol_version`. Bump together with a `.vN` package rename. */
const SKYRIMRP_PROTOCOL_VERSION = 1;

/** Build identifier sent on ClientHello — useful for server-side telemetry
 *  when diagnosing version drift. Webpack injects nothing here, so we read
 *  the static string from skymp5-client's package.json at build time would
 *  require a loader; keep it simple for now. */
const CLIENT_BUILD = "skyrimrp-client/0.1.0+phaseA";

/** Path the launcher writes; see `SkyrimRP/launcher/src-tauri/src/launcher.rs`. */
const SESSION_TOKEN_RELATIVE_PATH = "SkyrimRP/session.token";

export class SkyrimRpBootstrapService extends ClientListener {
  private transport: SkyrimRpTransport;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.transport = new SkyrimRpTransport(sp);

    this.controller.on("tick", () => this.transport.onTick());

    // Defer the actual dial off the constructor — we want all other
    // services to be wired up first so anything subscribing to
    // skymp's `connectionAccepted` / `disconnect` events still works.
    this.controller.once("update", () => this.start());
  }

  private start(): void {
    const host = this.readHost();
    const port = this.readPort();
    const token = this.readSessionToken();

    if (!token) {
      logTrace(
        this,
        "no SkyrimRP session token on disk — staying offline (vanilla SP behaviour)",
      );
      return;
    }
    if (!host || !port) {
      logError(this, "SkyrimRP server address not configured; cannot dial");
      return;
    }

    logTrace(this, `dialing SkyrimRP gateway ${host}:${port}`);
    this.transport
      .dial({
        host,
        port,
        sessionToken: token,
        protocolVersion: SKYRIMRP_PROTOCOL_VERSION,
        // 0 = "no character claimed", server picks default until char-select lands.
        // Use BigInt() call rather than 0n literal — skymp's tsconfig targets <ES2020.
        claimedCharacterId: BigInt(0),
        clientBuild: CLIENT_BUILD,
      })
      .then((ack) => {
        logTrace(this, `gateway accepted, session_id=${ack.sessionId}`);
        // Phase B/C will subscribe `transport.onFrame(...)` here to decode
        // SpawnPlayer / PlayerStateUpdate / ChatBroadcast / ServerStatsUpdate.
      })
      .catch((e) => {
        logError(this, `gateway dial failed: ${(e as Error).message}`);
      });
  }

  // ── config sources ─────────────────────────────────────────────────────

  /** Server host: read from SkyrimPlatform settings JSON. Launcher writes
   *  this file at `Data/Platform/Plugins/skyrimrp-client-settings.txt`. */
  private readHost(): string | undefined {
    const cfg = this.sp.settings["skyrimrp-client"] as
      | { "server-host"?: string }
      | undefined;
    return cfg?.["server-host"];
  }

  private readPort(): number | undefined {
    const cfg = this.sp.settings["skyrimrp-client"] as
      | { "server-port"?: number }
      | undefined;
    return cfg?.["server-port"];
  }

  /** Read `%LOCALAPPDATA%\SkyrimRP\session.token`. SkyrimPlatform doesn't
   *  expose `%LOCALAPPDATA%` directly; we use `sp.readDataFile` for game
   *  files but session tokens live outside Skyrim's tree. The launcher
   *  drops them in user-local appdata for per-Windows-account scoping.
   *
   *  SkyrimPlatform 2.8's `Utility.readFromFile` accepts an absolute path
   *  but its sandbox usually blocks it. The cleanest workaround: have the
   *  launcher ALSO mirror the token into
   *  `Data/Platform/Plugins/skyrimrp-client-token.txt` (per-install, less
   *  ideal security-wise but works inside the sandbox). For now we'll
   *  read from the standard SkyrimPlatform settings entry the launcher
   *  can also populate. */
  private readSessionToken(): string | undefined {
    // Settings-based path: the launcher can write the token into the
    // sp.settings JSON before launching the game.
    const fromSettings = (
      this.sp.settings["skyrimrp-client"] as
        | { "session-token"?: string }
        | undefined
    )?.["session-token"];
    if (fromSettings && fromSettings.length >= 32) return fromSettings;

    // Fallback: a sibling text file the launcher can drop into
    // Data/Platform/Plugins/. Same security profile as the settings JSON
    // (same directory). Read via SkyrimPlatform's data-file helper which
    // is sandbox-safe.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tok = (this.sp as any).readDataFile?.(
        "Platform/Plugins/skyrimrp-session.token",
      );
      if (typeof tok === "string" && tok.trim().length >= 32) {
        return tok.trim();
      }
    } catch {
      // ignore — fall through
    }

    // Last-ditch: read from %LOCALAPPDATA% via Utility.readFromFile. Won't
    // work in stock SkyrimPlatform 2.8 without sandbox loosening; left
    // here so the path appears in `git grep` once the runtime lifts that.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const utility = (this.sp as any).Utility;
      const localAppData = (this.sp as any).env?.LOCALAPPDATA;
      if (utility && localAppData) {
        const tok = utility.readFromFile(`${localAppData}\\${SESSION_TOKEN_RELATIVE_PATH}`);
        if (typeof tok === "string" && tok.trim().length >= 32) {
          return tok.trim();
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }
}
