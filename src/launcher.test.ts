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
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- a security downgrade dressed up as an optimisation.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "0.15.2", "0.16.0", "1.0.0", "0.15.1", "dev"]) {
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
      for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
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
      for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
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

describe("launcher fallbackInProcess()", () => {
  const fallbackInProcess = loadFallbackInProcess();

  it("serves a fallback in-process on Node, and on an oam host at the floor", () => {
    // The oam case is the sandbox one: a host at the floor only reaches a
    // fallback because ELECTRON_MCP_SANDBOX=1 sent it to discovery.
    for (const hostOam of [undefined, "0.15.2", "1.0.0"]) {
      assert.equal(fallbackInProcess(hostOam), true, `hostOam=${hostOam}`);
    }
  });

  it("never serves a fallback in-process on an oam host below the floor, or one with no readable version", () => {
    for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "", "dev"]) {
      assert.equal(fallbackInProcess(hostOam), false, `hostOam=${hostOam}`);
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 15, 1]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

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
  '  const run = args.indexOf("run");',
  '  const dashdash = args.indexOf("--");',
  "  const nodeArgs = run === -1 ? args : [args[run + 1], ...args.slice(dashdash + 1)];",
  "  return realSpawn.call(this, cmd, nodeArgs, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

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
const servedInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;
const IN_LAUNCHER_PROCESS = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const IN_CHILD = /LAUNCHER_ARGV1=.*electron-mcp\.mjs/;
const SANDBOX_DROPPED =
  /^electron-mcp: ELECTRON_MCP_SANDBOX=\S+ was not applied -- .*so the server runs WITHOUT --permission\.$/m;
const SANDBOX_REMEDY =
  /^To apply it, install or update oam \(0\.15\.2 or newer\) from https:\/\/oamjs\.org or set OAM_BIN=\/path\/to\/oam; set ELECTRON_MCP_RUNTIME=oam to make this fatal instead\.$/m;

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
      const run = await runLauncher("0.15.2", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
    }
  });

  it("still spawns under ELECTRON_MCP_SANDBOX=1, so --permission is not dropped", { skip }, async () => {
    const envs: Record<string, string>[] = [{}, { ELECTRON_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.15.2", { ELECTRON_MCP_SANDBOX: "1", ...extraEnv });
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
    assert.match(
      run.stderr,
      /^electron-mcp: ELECTRON_MCP_SANDBOX=maybe is not recognised; set it to 1 to enable the sandbox or 0 to disable it\. The server runs WITHOUT --permission\.$/m,
    );
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
      const session = await serveLauncher("0.15.2", { ELECTRON_MCP_SANDBOX: "1" }, SERVE_AS_OAM);
      assert.deepEqual(session.answered, [1, 2], JSON.stringify(session));
      assert.equal(session.exitedOnItsOwn, false, JSON.stringify(session));
      const args = recordedSpawnArgs(session);
      assert.ok(args, `no spawn was recorded: ${JSON.stringify(session)}`);
      assert.deepEqual(args.slice(0, 2), ["--permission", "run"], JSON.stringify(args));
      // Applied, so nothing to say: the sandbox is silent on success, and no
      // launcher line may claim otherwise.
      assert.doesNotMatch(session.stderr, /^electron-mcp: /m);
    },
  );

  it("spawns with no --permission at all when the sandbox is not requested", { skip }, async () => {
    const run = await runLauncher(undefined, {}, RECORD_SPAWN_ARGS);
    const args = recordedSpawnArgs(run);
    assert.ok(args, `no spawn was recorded: ${JSON.stringify(run)}`);
    assert.equal(args[0], "run", `the sandbox must be opt-in: ${JSON.stringify(args)}`);
    assert.equal(args.includes("--permission"), false);
  });

  it("still discovers when the host oam is below the floor", { skip }, async () => {
    const run = await runLauncher("0.15.1");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `electron-mcp: `.
    assert.doesNotMatch(run.stderr, /^electron-mcp: /m);
  });
});

describe("launcher with no usable oam", () => {
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
      /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
    );
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, IN_CHILD);
  });

  it(
    "under ELECTRON_MCP_SANDBOX=1, a supported oam host with nothing to spawn serves in-process and says so",
    { skip },
    async () => {
      const run = await runLauncher("0.15.2", isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout.trim(), PACKAGE_VERSION);
      assert.match(run.stderr, IN_LAUNCHER_PROCESS);
      assert.match(run.stderr, /^electron-mcp: OAM_BIN=.*does not exist; using this oam 0\.15\.2 process instead\.$/m);
      // The downgrade is never silent; the line explains itself on a host that
      // IS an oam ("fresh"), says how to get the sandbox applied, and names the
      // way to make its absence fatal.
      assert.match(run.stderr, SANDBOX_DROPPED);
      assert.match(run.stderr, /a fresh oam \(0\.15\.2 or newer\) is needed to apply it and none could be spawned/);
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
        "0.15.2",
        isolated({ ELECTRON_MCP_SANDBOX: "1", ELECTRON_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }),
      );
      assert.equal(run.code, 1, JSON.stringify(run));
      assert.equal(run.stdout.trim(), "", "nothing may be served");
      assert.match(
        run.stderr,
        /ELECTRON_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found, and ELECTRON_MCP_SANDBOX=1 needs one\./,
      );
      // The advice must not loop back: plain "use ELECTRON_MCP_RUNTIME=node"
      // would drop the sandbox the user just asked for without saying so.
      assert.match(
        run.stderr,
        /or drop ELECTRON_MCP_SANDBOX=1 and use ELECTRON_MCP_RUNTIME=node \(Node cannot apply the sandbox\)\./,
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
        /^electron-mcp: ELECTRON_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found\.$/m,
      );
      assert.match(run.stderr, /, or use ELECTRON_MCP_RUNTIME=node\.$/m);
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
    const run = await runLauncher("0.15.2", isolated({ ELECTRON_MCP_RUNTIME: "node" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, IN_CHILD);
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
    assert.match(run.stderr, /failed to launch oam at .*using Node instead/);
    // A newer oam WAS found; it would not start. The handoff note must say
    // that, not that none was found.
    assert.match(run.stderr, /this process is oam 0\.9\.0, older than 0\.15\.2, and the newer oam would not start;/);
    assert.doesNotMatch(run.stderr, /no newer oam was found/);
  });

  it(
    "under ELECTRON_MCP_SANDBOX=1, a supported oam host keeps serving in-process when the chosen oam fails to spawn",
    { skip },
    async () => {
      // The sandbox sends a 0.15.2 host to discovery -- the only way such a host
      // reaches a fallback. When the spawn fails, the documented fallback serves
      // in THIS process, and it has to KEEP serving: with the close handler
      // unguarded it would answer `initialize` and then exit on the dead child's
      // 'close', or, with stdin already piped into that child, stop reading
      // stdin. Both lose the second request, which `--version` cannot see.
      const session = await serveLauncher(
        "0.15.2",
        isolated({ ELECTRON_MCP_SANDBOX: "1", OAM_BIN: process.execPath }),
        FAIL_FIRST_SPAWN,
      );
      assert.deepEqual(session.answered, [1, 2], JSON.stringify(session));
      assert.equal(session.exitedOnItsOwn, false, JSON.stringify(session));
      assert.match(session.stderr, /failed to launch oam at .*; using this oam 0\.15\.2 process instead\./);
      assert.match(session.stderr, SANDBOX_DROPPED);
    },
  );
});
