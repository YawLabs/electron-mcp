import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// compiled file runs from dist/, one level below the repo root, as
// release-metadata.test.ts does.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(repoRoot, "bin", "electron-mcp.mjs");
const DIST_BIN = resolve(repoRoot, "dist", "index.js");
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string })
  .version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;
type FallbackInProcess = (hostOam: string | undefined) => boolean;
type SandboxSetting = "on" | "off" | "unrecognised";
type ParseSandboxSetting = (value: string | undefined) => SandboxSetting;
type ParseRuntimeSetting = (value: string | undefined) => { mode: "auto" | "oam" | "node"; recognised: boolean };

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/electron-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

function loadFallbackInProcess(): FallbackInProcess {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function fallbackInProcess\(hostOam\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn fallbackInProcess;`)() as FallbackInProcess;
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/electron-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.18.0 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.18.0 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.18.0", "0.19.0", "0.100.0", "1.0.0", "0.19.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- a security downgrade dressed up as an optimisation.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "0.18.0", "0.19.0", "1.0.0", "0.17.0", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: true }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than 0.9.0 treats `stdio: 'inherit'` as `'pipe'` and runs
    // `execFile` arguments through a shell, and anything older than the latest
    // release is not what the server is verified on.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.17.0", "0.15.2", "0.9.0", "0.8.2", "0.0.1"]) {
        for (const sandbox of [false, true]) {
          assert.equal(
            runtimePlan({ mode, hostOam, sandbox }),
            "discover",
            `mode=${mode} hostOam=${hostOam} sandbox=${sandbox}`,
          );
        }
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs ELECTRON_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    // The sandbox is moot here: Node has no `--permission` to apply, and the
    // launcher says so on stderr rather than changing the plan.
    for (const sandbox of [false, true]) {
      assert.equal(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), "in-process", `sandbox=${sandbox}`);
      for (const hostOam of ["0.8.2", "0.18.0", "1.0.0", "dev"]) {
        assert.equal(
          runtimePlan({ mode: "node", hostOam, sandbox }),
          "handoff-node",
          `hostOam=${hostOam} sandbox=${sandbox}`,
        );
      }
    }
  });
});

describe("launcher parseSandboxSetting()", () => {
  const parse = new Function(
    `${extract([/function parseSandboxSetting\(value\) \{[\s\S]*?\n\}/])}\nreturn parseSandboxSetting;`,
  )() as ParseSandboxSetting;

  it("enables on the common truthy spellings, case-insensitively and trimmed", () => {
    // A security opt-in that fails OPEN on `true` -- the natural spelling in a
    // JSON env block -- with nothing on stderr is a silent downgrade.
    for (const value of ["1", "true", "TRUE", "Yes", "on", " 1", "1 ", "\ton\n"]) {
      assert.equal(parse(value), "on", JSON.stringify(value));
    }
  });

  it("disables on unset, empty, and the common falsy spellings", () => {
    for (const value of [undefined, "", "0", "false", "False", "no", "OFF", "  "]) {
      assert.equal(parse(value), "off", JSON.stringify(value));
    }
  });

  it("reports anything else as unrecognised rather than guessing", () => {
    // Off is the safe reading of an unknown value; the launcher names it on
    // stderr so it is never a silent no-op either.
    for (const value of ["maybe", "01", "enable", "2", "yes please"]) {
      assert.equal(parse(value), "unrecognised", JSON.stringify(value));
    }
  });
});

describe("launcher parseRuntimeSetting()", () => {
  const parse = new Function(
    `${extract([/function parseRuntimeSetting\(value\) \{[\s\S]*?\n\}/])}\nreturn parseRuntimeSetting;`,
  )() as ParseRuntimeSetting;

  it("reads auto / oam / node case-insensitively and trimmed, and defaults to auto", () => {
    // `"oam "` in a JSON env block used to fall through to auto in silence,
    // which turned the fail-closed pairing (sandbox + RUNTIME=oam) into a
    // fail-open one on a stray space.
    for (const [value, mode] of [
      [undefined, "auto"],
      ["", "auto"],
      ["  ", "auto"],
      ["oam", "oam"],
      ["OAM", "oam"],
      [" oam ", "oam"],
      ["Node", "node"],
      ["auto\n", "auto"],
    ] as const) {
      assert.deepEqual(parse(value), { mode, recognised: true }, JSON.stringify(value));
    }
  });

  it("reports anything else as unrecognised, reading it as auto", () => {
    for (const value of ["oam.", "yes", "oam;node", "1", "nodejs"]) {
      assert.deepEqual(parse(value), { mode: "auto", recognised: false }, JSON.stringify(value));
    }
  });
});

describe("launcher fallbackInProcess()", () => {
  const fallbackInProcess = loadFallbackInProcess();

  it("serves a fallback in-process on Node, and on an oam host at the floor", () => {
    // The oam case is the sandbox one: a host at the floor only reaches a
    // fallback because ELECTRON_MCP_SANDBOX=1 sent it to discovery.
    for (const hostOam of [undefined, "0.18.0", "1.0.0"]) {
      assert.equal(fallbackInProcess(hostOam), true, `hostOam=${hostOam}`);
    }
  });

  it("never serves a fallback in-process on an oam host below the floor, or one with no readable version", () => {
    for (const hostOam of ["0.17.0", "0.15.2", "0.9.0", "0.8.2", "", "dev"]) {
      assert.equal(fallbackInProcess(hostOam), false, `hostOam=${hostOam}`);
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 18, 0]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 18, 0]), at("path-a", [0, 19, 0]), at("path-b", [0, 18, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 19, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 18, 0]), at("second", [0, 18, 0])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 18, 0])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 17, 0]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

describe("launcher stripPermissionFlags()", () => {
  const stripPermissionFlags = new Function(
    `${extract([/function stripPermissionFlags\(nodeOptions\) \{[\s\S]*?\n\}/])}\nreturn stripPermissionFlags;`,
  )() as (value: string | undefined) => string | undefined;

  it("removes --permission and every --allow-* token, keeping the rest in order", () => {
    assert.equal(
      stripPermissionFlags(
        "--max-old-space-size=4096 --permission --allow-env=PATH --allow-fs-read=* --trace-warnings",
      ),
      "--max-old-space-size=4096 --trace-warnings",
    );
  });

  it("returns undefined when nothing is left, or nothing was set", () => {
    assert.equal(stripPermissionFlags("--permission --allow-child-process"), undefined);
    assert.equal(stripPermissionFlags("   "), undefined);
    assert.equal(stripPermissionFlags(undefined), undefined);
  });
});

describe("launcher remedyFor()", () => {
  type Findings = {
    passedOver?: (number[] | null)[];
    overrideMissing?: boolean;
    failedToStart?: string | null;
    shim?: string | null;
  };
  const remedyFor = new Function(
    `${extract([OAM_MIN_DECL, /function remedyFor\([^)]*\) \{[\s\S]*?\n\}/])}\nreturn remedyFor;`,
  )() as (findings: Findings, platform: string, arch: string) => string[];

  it("sends an outdated oam to `oam self-update`, not to the website", () => {
    const clauses = remedyFor({ passedOver: [[0, 17, 1]] }, "win32", "arm64");
    assert.deepEqual(clauses, ["run `oam self-update` to get oam 0.18.0 or newer"]);
  });

  it("asks to check a binary that could not be run, rather than updating it", () => {
    const clauses = remedyFor({ passedOver: [null] }, "darwin", "arm64");
    assert.deepEqual(clauses, ["check that the oam found is an executable oam binary for this platform"]);
  });

  it("names each cause that was seen, and then never the website", () => {
    const clauses = remedyFor({ passedOver: [[0, 9, 0], null], overrideMissing: true }, "linux", "x64");
    assert.equal(clauses.length, 3, JSON.stringify(clauses));
    assert.ok(
      clauses.every((c) => !c.includes("oamjs.org")),
      JSON.stringify(clauses),
    );
  });

  it("points at a chosen oam that would not start", () => {
    const clauses = remedyFor({ failedToStart: "/opt/oam/oam" }, "linux", "x64");
    assert.deepEqual(clauses, ["check that the oam at /opt/oam/oam can be started, or set OAM_BIN=/path/to/oam"]);
  });

  it("sends someone with no oam at all to install one", () => {
    assert.deepEqual(remedyFor({}, "win32", "x64"), [
      "install oam (0.18.0 or newer) from https://oamjs.org, or set OAM_BIN=/path/to/oam",
    ]);
  });

  it("never offers an install on a Linux that oam publishes no build for", () => {
    const [clause] = remedyFor({}, "linux", "arm64");
    assert.match(clause, /oam publishes no build for linux-arm64/);
    assert.doesNotMatch(clause, /oamjs\.org/);
  });

  it("leaves a lone .cmd/.bat shim to its own note", () => {
    assert.deepEqual(remedyFor({ shim: "C:/tools/oam.cmd" }, "win32", "x64"), []);
  });
});

describe("launcher discoverOamPaths()", () => {
  type FakeProcess = { env: Record<string, string | undefined> };
  const discover = new Function(
    "process",
    "isWin",
    "exe",
    "existsSync",
    "realpathSync",
    "homedir",
    "join",
    "delimiter",
    `${extract([/function pathKey\(p\) \{[\s\S]*?\n\}/, /function discoverOamPaths\(\) \{[\s\S]*?\n\}/])}\nreturn discoverOamPaths();`,
  ) as (
    proc: FakeProcess,
    isWin: boolean,
    exe: string,
    existsSync: (p: string) => boolean,
    realpathSync: (p: string) => string,
    homedir: () => string,
    join: (...parts: string[]) => string,
    delimiter: string,
  ) => string[];
  const posixJoin = (...parts: string[]) => parts.join("/");
  const run = (env: Record<string, string | undefined>) =>
    discover(
      { env },
      false,
      "oam",
      () => true,
      (p) => p,
      () => "/home/u",
      posixJoin,
      ":",
    );

  it("searches OAM_INSTALL_DIR first when it is set: oam's own install target", () => {
    assert.deepEqual(run({ OAM_INSTALL_DIR: "/opt/oam", PATH: "/usr/bin" }), [
      "/opt/oam/oam",
      "/home/u/.oam/bin/oam",
      "/usr/bin/oam",
    ]);
  });

  it("keeps the default order when OAM_INSTALL_DIR is unset or empty", () => {
    for (const value of [undefined, ""]) {
      assert.deepEqual(run({ OAM_INSTALL_DIR: value, PATH: "/usr/bin" }), ["/home/u/.oam/bin/oam", "/usr/bin/oam"]);
    }
  });
});

/**
 * The `--import` preload every spawned launcher runs with: the argv[1] exit
 * marker, the optional oam pose, and any test-specific source appended.
 */
function preloadFor(hostOam: string | undefined, extraPreload: string): string[] {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}\n${extraPreload}`)}`];
}

/**
 * Preload source that makes the launcher's FIRST spawn target a path that does
 * not exist, and lets every later spawn through. That is the shape of a chosen
 * oam that passed its `--version` probe and then could not be spawned (deleted
 * or replaced in between). The version probe uses execFileSync, not spawn, so
 * it is untouched.
 */
const FAIL_FIRST_SPAWN = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const realSpawn = childProcess.spawn;",
  "let failed = false;",
  "childProcess.spawn = function (cmd, args, opts) {",
  "  if (failed) return realSpawn.call(this, cmd, args, opts);",
  "  failed = true;",
  '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/**
 * Preload source that reports every spawn's argv on stderr, as one
 * `SPAWN_ARGS=<json>` line, and lets the spawn through. This is how a test
 * sees the exact flags the launcher hands the runtime -- `--permission` and
 * where it sits relative to `run` -- rather than inferring them from the
 * child's exit code.
 */
const RECORD_SPAWN_ARGS = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  // The exit marker in preloadFor already imports `writeSync`; alias it here.
  'import { writeSync as writeStderr } from "node:fs";',
  "const realSpawn = childProcess.spawn;",
  "childProcess.spawn = function (cmd, args, opts) {",
  '  writeStderr(2, "SPAWN_ARGS=" + JSON.stringify(args) + "\\n");',
  "  return realSpawn.call(this, cmd, args, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/** The argv of the first spawn a RECORD_SPAWN_ARGS run reported, or null. */
function recordedSpawnArgs(run: { stderr: string }): string[] | null {
  const line = run.stderr.split("\n").find((l) => l.startsWith("SPAWN_ARGS="));
  return line ? (JSON.parse(line.slice("SPAWN_ARGS=".length)) as string[]) : null;
}

/**
 * Preload source that poses THIS launcher as an oam host running under
 * `--permission` with grants: `--permission` on execArgv (where oam lists argv
 * flags) and NODE_OPTIONS carrying oam-only grants, as 0.18's inheritance would
 * leave them. Set in the preload, not the child's env, so the Node running the
 * launcher never parses them itself.
 */
const POSE_PERMISSION_HOST = [
  'Object.defineProperty(process, "execArgv", { value: [...process.execArgv, "--permission"] });',
  'process.env.NODE_OPTIONS = "--allow-env=PATH --permission --allow-fs-read=* --max-old-space-size=4096";',
].join("\n");

/**
 * Preload source that reports every spawn's argv (SPAWN_ARGS=) and the
 * NODE_OPTIONS in its env (SPAWN_NODE_OPTIONS=, JSON, null when unset), and
 * lets the spawn through.
 */
const RECORD_SPAWN_ENV = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  'import { writeSync as writeStderr } from "node:fs";',
  "const realSpawn = childProcess.spawn;",
  "childProcess.spawn = function (cmd, args, opts) {",
  '  writeStderr(2, "SPAWN_ARGS=" + JSON.stringify(args) + "\\n");',
  "  const nodeOptions = opts && opts.env ? opts.env.NODE_OPTIONS : undefined;",
  '  writeStderr(2, "SPAWN_NODE_OPTIONS=" + JSON.stringify(nodeOptions ?? null) + "\\n");',
  "  return realSpawn.call(this, cmd, args, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/** The NODE_OPTIONS of the first spawn a RECORD_SPAWN_ENV run reported. */
function recordedSpawnNodeOptions(run: { stderr: string }): string | null | undefined {
  const line = run.stderr.split("\n").find((l) => l.startsWith("SPAWN_NODE_OPTIONS="));
  return line ? (JSON.parse(line.slice("SPAWN_NODE_OPTIONS=".length)) as string | null) : undefined;
}

/**
 * Preload source that records the spawn argv like RECORD_SPAWN_ARGS and then
 * rewrites oam's `[...flags, "run", <entry>, "--", ...argv]` into the Node form
 * `[<entry>, ...argv]` before spawning. OAM_BIN is the Node running the suite,
 * so the "oam" the launcher chose is a Node that can actually SERVE: this is
 * how the suite exercises a successful sandboxed spawn end to end -- the
 * launcher's piped stdio, the MCP handshake through it, and the child's exit
 * mirrored -- without a real oam on the box. The recorded argv still shows
 * exactly what a real oam would have received.
 */
const SERVE_AS_OAM = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  'import { writeSync as writeStderr } from "node:fs";',
  "const realSpawn = childProcess.spawn;",
  "childProcess.spawn = function (cmd, args, opts) {",
  '  writeStderr(2, "SPAWN_ARGS=" + JSON.stringify(args) + "\\n");',
  '  writeStderr(2, "SPAWN_STDIO=" + JSON.stringify(opts && opts.stdio) + "\\n");',
  '  const run = args.indexOf("run");',
  '  const dashdash = args.indexOf("--");',
  "  const nodeArgs = run === -1 ? args : [args[run + 1], ...args.slice(dashdash + 1)];",
  "  return realSpawn.call(this, cmd, nodeArgs, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/** The `stdio` option of the first spawn a SERVE_AS_OAM run reported, or null. */
function recordedSpawnStdio(run: { stderr: string }): unknown {
  const line = run.stderr.split("\n").find((l) => l.startsWith("SPAWN_STDIO="));
  return line ? JSON.parse(line.slice("SPAWN_STDIO=".length)) : null;
}

/**
 * The version string a host has to claim for the Node running this suite to
 * pass as that host's own oam: hostOamCandidate probes `process.execPath
 * --version` and accepts it only when it agrees with `process.versions.oam`.
 * Posing "0.18.0" on a Node execPath is therefore NOT a candidate (Node says
 * v22.x), which keeps every other test's "nothing to spawn" premise intact;
 * posing Node's own version IS one.
 */
const NODE_AS_HOST_OAM = process.version.replace(/^v/, "");

type ServeSession = { answered: number[]; stderr: string; exitedOnItsOwn: boolean; code: number | null };

/**
 * Launch the REAL bin with no argument, so it serves MCP over stdio, and hold a
 * short session: `initialize`, then -- only once that is answered -- a
 * `tools/list`. Resolves with the ids answered and whether the launcher exited
 * before the session was ended here.
 *
 * `--version` cannot see two failures this exists for, because it prints and
 * exits before either shows up. A launcher killed a moment after it answered
 * the first request still passes `--version`, and so does a server whose stdin
 * stopped delivering after the first chunk. The second request, sent only after
 * the first answer, catches both.
 */
function serveLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string>,
  extraPreload = "",
): Promise<ServeSession> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preloadFor(hostOam, extraPreload), LAUNCHER], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const answered: number[] = [];
    let buffered = "";
    let stderr = "";
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      child.kill();
    };
    // Well inside the suite-wide --test-timeout. A launcher that keeps running
    // without answering is reported by what it answered, not by a timeout.
    const deadline = setTimeout(stop, 30_000);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    // The launcher may die with requests unsent; that EPIPE is the finding, not a crash.
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let id: unknown;
        try {
          id = (JSON.parse(line) as { id?: unknown }).id;
        } catch {
          continue;
        }
        if (typeof id !== "number") continue;
        answered.push(id);
        if (id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (id === 2) {
          stop();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ answered, stderr, exitedOnItsOwn: !stopped, code });
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "launcher-test", version: "0.0.0" },
      },
    });
  });
}

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` and the sandbox
 * grant list -- which no amount of testing `runtimePlan` in isolation can. A
 * real oam cannot be assumed on every box this suite runs on, and the preload
 * changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, the pinned Node answers `--version` with v20 or newer, which clears
 * the floor, so it is chosen and the launcher spawns `node [flags] run <entry>`
 * -- which has no `run` subcommand, prints no version and exits non-zero. A
 * usable OAM_BIN is taken before discovery runs, so a real oam on the
 * developer's box is never reached either.
 *
 * Env is a whitelist so an ELECTRON_MCP_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
): Promise<LauncherRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preloadFor(hostOam, extraPreload), LAUNCHER, "--version"], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

// The in-process path imports dist/index.js, so these need a build. `npm test`
// always builds first; skip rather than fail when the compiled tests are run
// by hand against a dist/ that has no bundle. No per-test timeout: each case
// boots one to three Node processes, and the suite-wide --test-timeout in
// package.json already bounds a contended box.
const skip = existsSync(DIST_BIN) ? false : "dist/index.js is not built";

/**
 * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
 * empty directory, so the installed locations are empty, and PATH holds only
 * the directory of the Node running this test. Keeps a real oam on the
 * developer's box out of reach.
 */
function isolated(extra: Record<string, string> = {}): Record<string, string> {
  const empty = mkdtempSync(join(tmpdir(), "electron-mcp-launcher-home-"));
  return {
    PATH: dirname(process.execPath),
    USERPROFILE: empty,
    HOME: empty,
    LOCALAPPDATA: empty,
    ...extra,
  };
}

const MISSING_OAM = join(tmpdir(), "no-such-dir", "oam.exe");
const servedInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;
const IN_LAUNCHER_PROCESS = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const IN_CHILD = /LAUNCHER_ARGV1=.*electron-mcp\.mjs/;
const SANDBOX_DROPPED =
  /^electron-mcp: ELECTRON_MCP_SANDBOX=\S+ was not applied -- .*so the server runs WITHOUT --permission\.$/m;
// The remedy follows what discovery saw (remedyFor). Every isolated() run with
// a missing OAM_BIN sees exactly that and nothing else.
const SANDBOX_REMEDY =
  /^To apply it, point OAM_BIN at an existing oam binary, or unset it; set ELECTRON_MCP_RUNTIME=oam to make this fatal instead\.$/m;

describe("launcher on an oam host", () => {
  it("control: on plain Node the launcher still discovers and spawns", { skip }, async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runLauncher(undefined);
    assert.equal(servedInProcess(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", { skip }, async () => {
    const envs: Record<string, string>[] = [{}, { ELECTRON_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.18.0", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
    }
  });

  it("still spawns under ELECTRON_MCP_SANDBOX=1, so --permission is not dropped", { skip }, async () => {
    const envs: Record<string, string>[] = [{}, { ELECTRON_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.18.0", { ELECTRON_MCP_SANDBOX: "1", ...extraEnv });
      assert.equal(servedInProcess(run), false, `the sandbox must force a spawn, got ${JSON.stringify(run)}`);
      assert.notEqual(run.code, 0);
      // A spawned child failing, not the launcher diagnosing: every launcher
      // message starts with `electron-mcp: `.
      assert.doesNotMatch(run.stderr, /^electron-mcp: /m);
    }
  });

  it("passes --permission to oam BEFORE `run`, with no --allow-* grant", { skip }, async () => {
    // oam rejects `run --permission`, so where the flag sits is load-bearing,
    // and the empty grant list is the whole point of the sandbox: this server
    // needs no fs, child, net or env capability. Read straight off the spawn.
    const run = await runLauncher(undefined, { ELECTRON_MCP_SANDBOX: "1" }, RECORD_SPAWN_ARGS);
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.equal(args[0], "--permission");
    assert.equal(args[1], "run");
    assert.match(args[2], /dist[\\/]index\.js$/);
    assert.deepEqual(args.slice(3), ["--", "--version"]);
    assert.equal(
      args.filter((a) => a.startsWith("--allow")).length,
      0,
      `no grant may be emitted: ${JSON.stringify(args)}`,
    );
  });

  it("accepts ELECTRON_MCP_SANDBOX=true as well as 1, and 0/false as off", { skip }, async () => {
    // The parser is unit-tested above; this pins that the launcher actually
    // routes the env var through it. `true` is the natural spelling in a JSON
    // env block, and it used to fail OPEN with nothing on stderr.
    for (const value of ["true", "Yes"]) {
      const run = await runLauncher(undefined, { ELECTRON_MCP_SANDBOX: value }, RECORD_SPAWN_ARGS);
      const args = recordedSpawnArgs(run);
      assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
      assert.equal(args[0], "--permission", `ELECTRON_MCP_SANDBOX=${value}: ${JSON.stringify(args)}`);
      assert.doesNotMatch(run.stderr, /^electron-mcp: /m);
    }
    for (const value of ["0", "false"]) {
      const run = await runLauncher(undefined, { ELECTRON_MCP_SANDBOX: value }, RECORD_SPAWN_ARGS);
      const args = recordedSpawnArgs(run);
      assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
      assert.equal(args[0], "run", `ELECTRON_MCP_SANDBOX=${value}: ${JSON.stringify(args)}`);
      assert.doesNotMatch(run.stderr, /^electron-mcp: /m, "an explicit off is not news");
    }
  });

  it("names an unrecognised ELECTRON_MCP_SANDBOX value and runs without the sandbox", { skip }, async () => {
    const run = await runLauncher(undefined, { ELECTRON_MCP_SANDBOX: "maybe" }, RECORD_SPAWN_ARGS);
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.equal(args[0], "run", `an unknown value must read as off: ${JSON.stringify(args)}`);
    // States the reading only: it is printed before the launcher knows whether
    // anything will serve, so it may not claim the server runs without the
    // sandbox (that claim would sit above every fatal exit).
    assert.match(
      run.stderr,
      /^electron-mcp: ELECTRON_MCP_SANDBOX=maybe is not recognised and is treated as off; set it to 1 to enable the sandbox or 0 to disable it\.$/m,
    );
    assert.doesNotMatch(run.stderr, /WITHOUT --permission/);
  });

  it("names an unrecognised ELECTRON_MCP_RUNTIME value and treats it as auto", { skip }, async () => {
    // A typo here used to fall through to auto in silence -- and under the
    // fail-closed pairing that turned "sandbox required" into "sandbox if
    // convenient" with nothing on stderr.
    const run = await runLauncher(undefined, { ELECTRON_MCP_RUNTIME: "oam;" }, RECORD_SPAWN_ARGS);
    assert.ok(recordedSpawnArgs(run), `auto must still discover and spawn: ${JSON.stringify(run)}`);
    assert.match(
      run.stderr,
      /^electron-mcp: ELECTRON_MCP_RUNTIME=oam; is not recognised and is treated as auto; use auto, oam or node\.$/m,
    );
  });

  it("trims ELECTRON_MCP_RUNTIME, so a padded `oam` keeps the fail-closed pairing closed", { skip }, async () => {
    const run = await runLauncher(
      undefined,
      isolated({ ELECTRON_MCP_SANDBOX: "1", ELECTRON_MCP_RUNTIME: "oam ", OAM_BIN: MISSING_OAM }),
    );
    assert.equal(run.code, 1, `a padded oam must still be oam: ${JSON.stringify(run)}`);
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.doesNotMatch(run.stderr, /is not recognised/);
  });

  it(
    "serves through a sandboxed spawn from an oam host: piped stdio, full handshake, --permission on the argv",
    { skip },
    async () => {
      // The primary new path, end to end: an at-floor oam host under the sandbox
      // spawns a fresh runtime with --permission before `run`, pipes stdio into
      // it (an oam host never inherits -- see ALREADY RUNNING ON OAM), and the
      // MCP session completes through the pipes. The child is the Node running
      // this suite, posing as oam; SERVE_AS_OAM records the oam-shaped argv and
      // translates it so Node can serve.
      const session = await serveLauncher("0.18.0", { ELECTRON_MCP_SANDBOX: "1" }, SERVE_AS_OAM);
      assert.deepEqual(session.answered, [1, 2], JSON.stringify(session));
      assert.equal(session.exitedOnItsOwn, false, JSON.stringify(session));
      const args = recordedSpawnArgs(session);
      assert.ok(args, `no spawn was recorded: ${JSON.stringify(session)}`);
      assert.deepEqual(args.slice(0, 2), ["--permission", "run"], JSON.stringify(args));
      // Piped, not inherited: read straight off the spawn options, because a
      // Node posing as oam would complete the handshake either way and could
      // not tell the two apart.
      assert.deepEqual(recordedSpawnStdio(session), ["pipe", "pipe", "pipe"], "an oam host must pipe, never inherit");
      // Applied, so nothing to say: the sandbox is silent on success, and no
      // launcher line may claim otherwise.
      assert.doesNotMatch(session.stderr, /^electron-mcp: /m);
    },
  );

  it("spawns a fresh copy of the host's OWN oam for the sandbox when nothing else is installed", { skip }, async () => {
    // Yaw MCP launches this bin from an oam bundled inside the app -- not on
    // PATH, not in an installed location. That host must be able to sandbox:
    // its own binary is the one oam guaranteed to exist. The host here is the
    // suite's Node posing as an oam of Node's own version, so the execPath
    // probe agrees with the claimed version and it qualifies as the candidate;
    // OAM_BIN is missing and PATH holds no oam, so nothing else could be chosen.
    const session = await serveLauncher(
      NODE_AS_HOST_OAM,
      isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }),
      SERVE_AS_OAM,
    );
    assert.deepEqual(session.answered, [1, 2], JSON.stringify(session));
    const args = recordedSpawnArgs(session);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(session)}`);
    assert.deepEqual(args.slice(0, 2), ["--permission", "run"], JSON.stringify(args));
    // The unusable OAM_BIN is still named, and the chosen binary is this one.
    assert.match(session.stderr, /^electron-mcp: OAM_BIN=.*does not exist; using .* \(oam \d+\.\d+\.\d+\)\.$/m);
    assert.doesNotMatch(session.stderr, /runs WITHOUT --permission/);
  });

  it("does not mistake a host whose binary reports a different version for its own oam", { skip }, async () => {
    // The guard that keeps the case above honest: a wrapper on execPath, or a
    // Node posing as "0.18.0", is not an oam that can spawn a sandboxed child.
    // With nothing else to spawn, that host falls back in-process and says so.
    const run = await runLauncher(
      "0.18.0",
      isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }),
      RECORD_SPAWN_ARGS,
    );
    assert.equal(recordedSpawnArgs(run), null, `nothing may be spawned: ${JSON.stringify(run)}`);
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, SANDBOX_DROPPED);
  });

  it("spawns with no --permission at all when the sandbox is not requested", { skip }, async () => {
    const run = await runLauncher(undefined, {}, RECORD_SPAWN_ARGS);
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.equal(args[0], "run", `the sandbox must be opt-in: ${JSON.stringify(args)}`);
    assert.equal(args.includes("--permission"), false);
  });

  it("still discovers when the host oam is below the floor", { skip }, async () => {
    const run = await runLauncher("0.17.0");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `electron-mcp: `.
    assert.doesNotMatch(run.stderr, /^electron-mcp: /m);
  });
});

describe("launcher with no usable oam", () => {
  it("names an OAM_BIN that does not exist instead of falling back silently", { skip }, async () => {
    const run = await runLauncher(undefined, isolated({ OAM_BIN: MISSING_OAM }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /^electron-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
    // No sandbox was asked for, so nothing may mention one.
    assert.doesNotMatch(run.stderr, /SANDBOX|--permission/);
  });

  it("hands a below-floor oam host off to Node rather than serving on it", { skip }, async () => {
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: MISSING_OAM }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node child must still serve");
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.18\.0, and no newer oam was found; running on .*node/,
    );
    // The OAM_BIN note names no target: Node has not been looked for at that
    // point, and the handoff line above names it once it has been found.
    assert.match(run.stderr, /^electron-mcp: OAM_BIN=.*does not exist\.$/m);
    assert.doesNotMatch(run.stderr, /does not exist; using Node instead/);
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, IN_CHILD);
  });

  it(
    "under ELECTRON_MCP_SANDBOX=1, a supported oam host with nothing to spawn serves in-process and says so",
    { skip },
    async () => {
      const run = await runLauncher("0.18.0", isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout.trim(), PACKAGE_VERSION);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
      assert.match(run.stderr, /^electron-mcp: OAM_BIN=.*does not exist; using this oam 0\.18\.0 process instead\.$/m);
      // The downgrade is never silent; the line explains itself on a host that
      // IS an oam ("fresh"), says how to get the sandbox applied, and names the
      // way to make its absence fatal.
      assert.match(run.stderr, SANDBOX_DROPPED);
      assert.match(run.stderr, /a fresh oam \(0\.18\.0 or newer\) is needed to apply it and none could be spawned/);
      assert.match(run.stderr, SANDBOX_REMEDY);
    },
  );

  it(
    "under ELECTRON_MCP_SANDBOX=1, a Node host with nothing to spawn serves in-process and says so",
    { skip },
    async () => {
      const run = await runLauncher(undefined, isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout.trim(), PACKAGE_VERSION);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
      assert.match(run.stderr, SANDBOX_DROPPED);
    },
  );

  it(
    "under ELECTRON_MCP_SANDBOX=1 and ELECTRON_MCP_RUNTIME=oam, nothing to spawn is fatal even on a supported oam host",
    { skip },
    async () => {
      const run = await runLauncher(
        "0.18.0",
        isolated({ ELECTRON_MCP_SANDBOX: "1", ELECTRON_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }),
      );
      assert.equal(run.code, 1, JSON.stringify(run));
      assert.equal(run.stdout.trim(), "", "nothing may be served");
      assert.match(
        run.stderr,
        /ELECTRON_MCP_RUNTIME=oam but no usable oam \(0\.18\.0 or newer\) was found, and ELECTRON_MCP_SANDBOX=\S+ needs one\./,
      );
      // The advice must not loop back: plain "use ELECTRON_MCP_RUNTIME=node"
      // would drop the sandbox the user just asked for without saying so.
      assert.match(
        run.stderr,
        /^Or drop ELECTRON_MCP_SANDBOX=\S+ and use ELECTRON_MCP_RUNTIME=node \(Node cannot apply the sandbox\)\.$/m,
      );
      // Fatal is fatal: nothing may claim the server runs without the sandbox.
      assert.doesNotMatch(run.stderr, /runs WITHOUT --permission/);
    },
  );

  it(
    "under ELECTRON_MCP_RUNTIME=oam without the sandbox, the error still offers ELECTRON_MCP_RUNTIME=node plainly",
    { skip },
    async () => {
      const run = await runLauncher("0.9.0", isolated({ ELECTRON_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }));
      assert.equal(run.code, 1, JSON.stringify(run));
      assert.match(
        run.stderr,
        /^electron-mcp: ELECTRON_MCP_RUNTIME=oam but no usable oam \(0\.18\.0 or newer\) was found\.$/m,
      );
      assert.match(run.stderr, /^Or use ELECTRON_MCP_RUNTIME=node\.$/m);
      // The remedy names the cause that was seen -- a missing OAM_BIN -- and
      // does not send anyone to the website when something was configured.
      assert.match(run.stderr, /^Point OAM_BIN at an existing oam binary, or unset it\.$/m);
      assert.doesNotMatch(run.stderr, /oamjs\.org/);
      assert.doesNotMatch(run.stderr, /SANDBOX/);
    },
  );

  it(
    "under ELECTRON_MCP_SANDBOX=1 and ELECTRON_MCP_RUNTIME=node, serves on Node and says the sandbox is moot",
    { skip },
    async () => {
      const run = await runLauncher(undefined, isolated({ ELECTRON_MCP_SANDBOX: "1", ELECTRON_MCP_RUNTIME: "node" }));
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout.trim(), PACKAGE_VERSION);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
      assert.match(run.stderr, SANDBOX_DROPPED);
      assert.match(run.stderr, /ELECTRON_MCP_RUNTIME=node runs the server on Node/);
      // The next step for an explicit request to run on Node is to drop that
      // request, not to demand oam.
      assert.match(run.stderr, /^Remove ELECTRON_MCP_RUNTIME=node to let the launcher use oam\.$/m);
      assert.doesNotMatch(run.stderr, /make this fatal/);
    },
  );

  it("refuses to serve on a below-floor oam host when there is no Node either", { skip }, async () => {
    const empty = isolated();
    const noNode = mkdtempSync(join(tmpdir(), "electron-mcp-launcher-nopath-"));
    const run = await runLauncher("0.9.0", { ...empty, PATH: noNode, OAM_BIN: join(noNode, "oam.exe") });
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
  });

  it(
    "under ELECTRON_MCP_SANDBOX=1, a fatal exit never claims the server runs without the sandbox",
    { skip },
    async () => {
      // The "runs WITHOUT --permission" line is printed only once a path is
      // committed to serving. Two ways to reach an exit that served nothing:
      // a below-floor oam host with no Node on PATH, under auto and under
      // ELECTRON_MCP_RUNTIME=node.
      const empty = isolated();
      const noNode = mkdtempSync(join(tmpdir(), "electron-mcp-launcher-nopath-"));
      const envs: Record<string, string>[] = [{}, { ELECTRON_MCP_RUNTIME: "node" }];
      for (const extraEnv of envs) {
        const run = await runLauncher("0.9.0", {
          ...empty,
          ...extraEnv,
          PATH: noNode,
          OAM_BIN: join(noNode, "oam.exe"),
          ELECTRON_MCP_SANDBOX: "1",
        });
        assert.equal(run.code, 1, JSON.stringify(run));
        assert.equal(run.stdout.trim(), "", "nothing may be served");
        assert.match(run.stderr, /no Node was found on PATH/);
        assert.doesNotMatch(run.stderr, /runs WITHOUT --permission/, JSON.stringify(extraEnv));
      }
    },
  );

  it("hands ELECTRON_MCP_RUNTIME=node off to Node even on a supported oam host", { skip }, async () => {
    // The host sits AT the floor, so this exercises the "node was asked for"
    // branch, not the below-floor handoff: no below-floor reason may appear.
    const run = await runLauncher("0.18.0", isolated({ ELECTRON_MCP_RUNTIME: "node" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, IN_CHILD);
    assert.doesNotMatch(run.stderr, /older than \d+\.\d+\.\d+/);
  });

  it("still falls back when the chosen oam fails to spawn on an oam host", { skip }, async () => {
    // The chosen binary passed its --version probe and then could not be
    // spawned (deleted or replaced in between). A failed spawn emits 'error'
    // and then 'close' with the negative errno, and on an oam host the launcher
    // waits for 'close' -- so an unguarded close handler would exit the launcher
    // mid-fallback and nothing would serve. The preload makes the FIRST spawn
    // target a path that does not exist; the Node fallback spawns normally.
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), FAIL_FIRST_SPAWN);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    // The launch-failure line names no target (Node has not been looked for
    // yet); the handoff line that follows names it once found.
    assert.match(run.stderr, /^electron-mcp: failed to launch oam at .*\)\.$/m);
    assert.doesNotMatch(run.stderr, /failed to launch oam at .*using Node instead/);
    // A newer oam WAS found; it would not start. The handoff note must say
    // that, not that none was found.
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.18\.0, and the newer oam would not start; running on .*node/,
    );
    assert.doesNotMatch(run.stderr, /no newer oam was found/);
  });

  it(
    "under ELECTRON_MCP_SANDBOX=1, a supported oam host keeps serving in-process when the chosen oam fails to spawn",
    { skip },
    async () => {
      // The sandbox sends a 0.18.0 host to discovery -- the only way such a host
      // reaches a fallback. When the spawn fails, the documented fallback serves
      // in THIS process, and it has to KEEP serving: with the close handler
      // unguarded it would answer `initialize` and then exit on the dead child's
      // 'close', or, with stdin already piped into that child, stop reading
      // stdin. Both lose the second request, which `--version` cannot see.
      const session = await serveLauncher(
        "0.18.0",
        isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: process.execPath }),
        FAIL_FIRST_SPAWN,
      );
      assert.deepEqual(session.answered, [1, 2], JSON.stringify(session));
      assert.equal(session.exitedOnItsOwn, false, JSON.stringify(session));
      assert.match(session.stderr, /failed to launch oam at .*; using this oam 0\.18\.0 process instead\./);
      assert.match(session.stderr, SANDBOX_DROPPED);
    },
  );
});

describe("launcher Node handoff from an oam host under --permission", () => {
  // oam 0.18 appends a --permission host's flags to a child's NODE_OPTIONS
  // unless the child's argv holds --permission, and Node exits 9 on oam-only
  // ones such as --allow-env= (measured on oam 0.18.0 / Node 22.22.2). Node's
  // --permission is stable from 22.13; an older Node cannot serve this way, so
  // the serving half is asserted only where the suite's Node has it.
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeHasPermission = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);

  it("puts --permission before the entry on Node's argv and strips the inherited flags", { skip }, async () => {
    const run = await runLauncher(
      "0.18.0",
      isolated({ ELECTRON_MCP_RUNTIME: "node" }),
      `${POSE_PERMISSION_HOST}\n${RECORD_SPAWN_ENV}`,
    );
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.equal(args[0], "--permission", JSON.stringify(args));
    assert.match(args[1], /dist[\\/]index\.js$/, JSON.stringify(args));
    assert.equal(recordedSpawnNodeOptions(run), "--max-old-space-size=4096");
    assert.match(
      run.stderr,
      /^electron-mcp: this oam 0\.18\.0 process runs under --permission, so Node runs the server under --permission too \(no grants\)\.$/m,
    );
    // Served under a permission model, so the "WITHOUT --permission" line
    // would be false here.
    assert.doesNotMatch(run.stderr, /runs WITHOUT --permission/);
    if (nodeHasPermission) {
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    }
  });

  it("adds no --permission when the host is not under it, but still strips NODE_OPTIONS", { skip }, async () => {
    const run = await runLauncher(
      "0.18.0",
      isolated({ ELECTRON_MCP_RUNTIME: "node" }),
      `process.env.NODE_OPTIONS = "--allow-net=example.com --max-old-space-size=4096";\n${RECORD_SPAWN_ENV}`,
    );
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.match(args[0], /dist[\\/]index\.js$/, JSON.stringify(args));
    assert.equal(recordedSpawnNodeOptions(run), "--max-old-space-size=4096");
    assert.doesNotMatch(run.stderr, /runs under --permission/);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
  });

  it("strips inherited grants from the sandboxed oam spawn, so bare --permission stays bare", { skip }, async () => {
    const run = await runLauncher(
      "0.18.0",
      { ELECTRON_MCP_SANDBOX: "1" },
      `${POSE_PERMISSION_HOST}\n${RECORD_SPAWN_ENV}`,
    );
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.deepEqual(args.slice(0, 2), ["--permission", "run"], JSON.stringify(args));
    assert.equal(recordedSpawnNodeOptions(run), "--max-old-space-size=4096");
  });

  it(
    "leaves NODE_OPTIONS alone on a plain oam spawn, which inherits the host's grants by design",
    { skip },
    async () => {
      const run = await runLauncher(
        "0.9.0",
        {},
        `process.env.NODE_OPTIONS = "--allow-fs-read=* --max-old-space-size=4096";\n${RECORD_SPAWN_ENV}`,
      );
      const args = recordedSpawnArgs(run);
      assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
      assert.equal(args[0], "run", JSON.stringify(args));
      assert.equal(recordedSpawnNodeOptions(run), "--allow-fs-read=* --max-old-space-size=4096");
    },
  );
});
