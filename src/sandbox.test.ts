import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The sandbox claim, measured against a REAL oam.
 *
 * The launcher header, README and CHANGELOG all say that under oam's bare
 * `--permission` -- no `--allow-*` at all -- every tool answers exactly as it
 * does on Node. bundle-surface.test.ts pins that statically. This file pins it
 * at runtime: it drives the built server through `initialize`, `tools/list`
 * and one `tools/call` per tool, once under `oam --permission run` and once
 * under plain Node, and requires the two runs to agree tool for tool. A tool
 * that started reading a file, spawning a process or opening a socket would
 * answer with ERR_ACCESS_DENIED under the sandbox and differ from the Node run,
 * so the diff goes red in review rather than in a user's session.
 *
 * A real oam cannot be assumed on every box the suite runs on, so the whole
 * file skips -- loudly, naming why -- when no oam at or above the launcher's
 * floor is reachable through OAM_BIN, the installed locations the launcher
 * checks, or PATH. release.sh refuses to release on a skip, so every release
 * is verified this way.
 *
 * Arguments are synthesized from each tool's inputSchema (every property,
 * with the first enum value, a snippet of Electron code for code-shaped
 * strings, and so on). They do not have to be MEANINGFUL, but they do have to
 * get every handler past argument validation and to a normal result on Node:
 * a tool the SDK rejects before dispatch never executes on either runtime,
 * and a differential over two identical rejections proves nothing. So the
 * Node run is required to be all `ok` first, and only then compared.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(repoRoot, "bin", "electron-mcp.mjs");
const DIST_BIN = resolve(repoRoot, "dist", "index.js");

/** The launcher's floor, read from the launcher so the two cannot drift. */
function launcherFloor(): number[] {
  const m = readFileSync(LAUNCHER, "utf-8").match(/const OAM_MIN = \[([^\]]*)\];/);
  if (!m) throw new Error("could not read OAM_MIN from bin/electron-mcp.mjs");
  return m[1].split(",").map((n) => Number(n.trim()));
}

function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: number[] | null, min: number[]): boolean {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * An oam binary at or above the floor: OAM_BIN, then the installed locations
 * the launcher's discoverOamPaths checks (%LOCALAPPDATA%\oam\bin on Windows,
 * ~/.oam/bin), then PATH. Null if none. Every candidate is probed, so an old
 * oam early in the order cannot hide a current one later.
 */
function findUsableOam(): { path: string; version: number[] } | null {
  const floor = launcherFloor();
  const exe = process.platform === "win32" ? "oam.exe" : "oam";
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (process.platform === "win32") {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const candidates = [
    ...(process.env.OAM_BIN ? [process.env.OAM_BIN] : []),
    ...installed,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, exe)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let version: number[] | null = null;
    try {
      version = parseVersion(
        execFileSync(candidate, ["--version"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        }),
      );
    } catch {
      continue;
    }
    if (version && atLeast(version, floor)) return { path: candidate, version };
  }
  return null;
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
};

const SAMPLE_CODE = [
  'import { app, BrowserWindow, ipcMain } from "electron";',
  "const win = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });",
  'ipcMain.handle("read-file", (e, p) => require("fs").readFileSync(p));',
  'win.loadURL("http://example.com");',
].join("\n");

/**
 * A schema-valid value for a field, by shape and by name. Every property is
 * filled, not just the required ones, so optional inputs (a preload, an HTML
 * file, a package.json) reach their code paths too. Names are chosen to pass
 * the tools' own validators: channels are `scope:action`, identifiers and
 * package names are plain, a target version is above the current one.
 */
function sampleFor(schema: JsonSchema | undefined, name: string): unknown {
  if (!schema) return undefined;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case "string":
      if (/code|content|html|json|output|error/i.test(name)) return SAMPLE_CODE;
      if (/version/i.test(name)) return "38";
      if (/channel/i.test(name)) return "app:get-data";
      if (/name|id/i.test(name)) return "sample_app";
      if (/url|scheme|host/i.test(name)) return "myapp";
      return "sample";
    case "number":
    case "integer":
      return (schema.minimum ?? 30) + (/target/i.test(name) ? 1 : 0);
    case "boolean":
      return true;
    case "array":
      return [sampleFor(schema.items ?? { type: "string" }, name)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(schema.properties ?? {})) out[key] = sampleFor(sub, key);
      return out;
    }
    default:
      if (schema.anyOf) return sampleFor(schema.anyOf[0], name);
      return "sample";
  }
}

type Tool = { name: string; inputSchema: JsonSchema };
type Content = { type: string; text?: string };
type RpcResponse = {
  id?: number;
  result?: { tools?: Tool[]; isError?: boolean; content?: Content[] };
  error?: { message: string };
};
/** One tool's outcome, in the form the two runs are compared on. */
type Outcome = "ok" | "isError" | `rpc-error: ${string}`;
type Sweep = { tools: string[]; outcomes: Record<string, Outcome>; texts: Record<string, string>; stderr: string };

/** Drive a server through initialize, tools/list and one call per tool. */
function sweep(cmd: string, args: string[]): Promise<Sweep> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const pending = new Map<number, (m: RpcResponse) => void>();
    let nextId = 1;
    let buffered = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          continue;
        }
        if (typeof msg.id !== "number") continue;
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
    child.on("error", reject);
    const request = (method: string, params: unknown): Promise<RpcResponse> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        const deadline = setTimeout(
          () => rej(new Error(`no answer to ${method} (id ${id}) in 30s; stderr: ${stderr}`)),
          30_000,
        );
        pending.set(id, (m) => {
          clearTimeout(deadline);
          res(m);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };
    (async () => {
      const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sandbox-test", version: "0.0.0" },
      });
      if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const list = await request("tools/list", {});
      const tools = list.result?.tools ?? [];
      const outcomes: Record<string, Outcome> = {};
      const texts: Record<string, string> = {};
      for (const tool of tools) {
        const res = await request("tools/call", {
          name: tool.name,
          arguments: sampleFor(tool.inputSchema, tool.name) ?? {},
        });
        outcomes[tool.name] = res.error ? `rpc-error: ${res.error.message}` : res.result?.isError ? "isError" : "ok";
        texts[tool.name] =
          (res.result?.content ?? []).map((c) => c.text ?? "").join("\n") || (res.error?.message ?? "");
      }
      child.stdin.end();
      await new Promise((r) => child.on("close", r));
      return { tools: tools.map((t) => t.name).sort(), outcomes, texts, stderr };
    })().then(resolvePromise, (err) => {
      child.kill();
      reject(err);
    });
  });
}

const oam = findUsableOam();
const skip = !existsSync(DIST_BIN)
  ? "dist/index.js is not built"
  : oam
    ? false
    : `no oam ${launcherFloor().join(".")} or newer on OAM_BIN, in ~/.oam/bin, or on PATH -- install one from https://oamjs.org to run this`;

/** What a denied capability looks like from inside a tool result. */
const DENIAL = /ERR_ACCESS_DENIED|Access to this API has been restricted/;

describe("server under oam --permission with no grants", () => {
  it("every tool answers exactly as it does on Node", { skip }, async () => {
    if (!oam) return;
    // Bare --permission BEFORE `run`: the same argv the launcher builds under
    // ELECTRON_MCP_SANDBOX=1 (see sandboxFlags in bin/electron-mcp.mjs).
    const sandboxed = await sweep(oam.path, ["--permission", "run", DIST_BIN]);
    const plain = await sweep(process.execPath, [DIST_BIN]);

    assert.ok(plain.tools.length >= 18, `expected the full tool set on Node, got ${plain.tools.length}`);
    // The Node run must reach a normal result on EVERY tool: a handler the SDK
    // rejects before dispatch never ran, and a differential over two identical
    // rejections proves nothing about the sandbox. If a schema change makes a
    // synthesized argument invalid, this fails here, by name, instead of
    // silently shrinking the comparison.
    const notOk = Object.entries(plain.outcomes).filter(([, o]) => o !== "ok");
    assert.deepEqual(notOk, [], `every handler must run to a normal result on Node: ${JSON.stringify(notOk)}`);
    assert.deepEqual(sandboxed.tools, plain.tools, "the sandboxed server must list the same tools");
    // The load-bearing assertion: tool for tool, the same outcome under the
    // sandbox as on Node.
    assert.deepEqual(sandboxed.outcomes, plain.outcomes, "every tool must produce the same outcome under the sandbox");
    // A denial inside a handler is folded by the SDK into the RESULT (isError
    // with the message in content), never stderr -- so look where it would be.
    for (const [name, text] of Object.entries(sandboxed.texts)) {
      assert.doesNotMatch(text, DENIAL, `sandbox denial inside ${name}'s result`);
    }
    assert.doesNotMatch(sandboxed.stderr, DENIAL, `sandbox denial on stderr: ${sandboxed.stderr}`);
  });

  it("control: the same oam refuses a filesystem read under the same flag", { skip }, () => {
    // Without this, the differential above would also pass on an oam whose
    // --permission did nothing. A one-line script that reads its own package
    // manifest must be refused -- proving the sandbox the server just ran
    // under is real.
    if (!oam) return;
    // `-e` evaluates as CommonJS (as in Node), hence require() rather than import.
    const probe = [
      'const { readFileSync } = require("node:fs");',
      `try { readFileSync(${JSON.stringify(join(repoRoot, "package.json"))}); console.log("READ"); }`,
      'catch (e) { console.log("denied:" + e.code); }',
    ].join(" ");
    const out = execFileSync(oam.path, ["--permission", "-e", probe], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    assert.match(out, /denied:ERR_ACCESS_DENIED/, `expected the read to be refused, got: ${out}`);
  });
});
