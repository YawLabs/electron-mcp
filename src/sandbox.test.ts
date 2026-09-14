import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
 * floor is reachable through OAM_BIN or PATH. release.sh runs `npm test` on a
 * workstation that has one, so every release is verified this way.
 *
 * Arguments are synthesized from each tool's inputSchema (the first enum
 * value, a snippet of Electron code for code-shaped strings, and so on). They
 * do not have to be MEANINGFUL: a tool that rejects them does so identically
 * on both runtimes, and the differential is the assertion. What matters is
 * that every tool's handler actually executes.
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

/** An oam binary at or above the floor: OAM_BIN first, then PATH. Null if none. */
function findUsableOam(): { path: string; version: number[] } | null {
  const floor = launcherFloor();
  const exe = process.platform === "win32" ? "oam.exe" : "oam";
  const candidates = [
    ...(process.env.OAM_BIN ? [process.env.OAM_BIN] : []),
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

/** A schema-valid value for a required field, by shape and by name. */
function sampleFor(schema: JsonSchema | undefined, name: string): unknown {
  if (!schema) return undefined;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case "string":
      if (/code|content|html|json|output|error/i.test(name)) return SAMPLE_CODE;
      if (/version/i.test(name)) return "38";
      if (/name|channel|id/i.test(name)) return "app:get-data";
      if (/url|scheme|host/i.test(name)) return "myapp";
      return "sample";
    case "number":
    case "integer":
      return schema.minimum ?? 30;
    case "boolean":
      return true;
    case "array":
      return [sampleFor(schema.items ?? { type: "string" }, name)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = sampleFor(schema.properties?.[key], key);
      return out;
    }
    default:
      if (schema.anyOf) return sampleFor(schema.anyOf[0], name);
      return "sample";
  }
}

type Tool = { name: string; inputSchema: JsonSchema };
type RpcResponse = { id?: number; result?: { tools?: Tool[]; isError?: boolean }; error?: { message: string } };
/** One tool's outcome, in the form the two runs are compared on. */
type Outcome = "ok" | "isError" | `rpc-error: ${string}`;
type Sweep = { tools: string[]; outcomes: Record<string, Outcome>; stderr: string };

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
      for (const tool of tools) {
        const res = await request("tools/call", {
          name: tool.name,
          arguments: sampleFor(tool.inputSchema, tool.name) ?? {},
        });
        outcomes[tool.name] = res.error ? `rpc-error: ${res.error.message}` : res.result?.isError ? "isError" : "ok";
      }
      child.stdin.end();
      await new Promise((r) => child.on("close", r));
      return { tools: tools.map((t) => t.name).sort(), outcomes, stderr };
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
    : `no oam ${launcherFloor().join(".")} or newer on OAM_BIN or PATH -- install one from https://oamjs.org to run this`;

describe("server under oam --permission with no grants", () => {
  it("every tool answers exactly as it does on Node", { skip }, async () => {
    if (!oam) return;
    // Bare --permission BEFORE `run`: the same argv the launcher builds under
    // ELECTRON_MCP_SANDBOX=1 (see sandboxFlags in bin/electron-mcp.mjs).
    const sandboxed = await sweep(oam.path, ["--permission", "run", DIST_BIN]);
    const plain = await sweep(process.execPath, [DIST_BIN]);

    assert.ok(plain.tools.length >= 18, `expected the full tool set on Node, got ${plain.tools.length}`);
    assert.deepEqual(sandboxed.tools, plain.tools, "the sandboxed server must list the same tools");
    assert.deepEqual(sandboxed.outcomes, plain.outcomes, "every tool must produce the same outcome under the sandbox");
    assert.doesNotMatch(sandboxed.stderr, /ERR_ACCESS_DENIED/, `sandbox denial on stderr: ${sandboxed.stderr}`);
    // Every handler executed, not merely listed: an outcome exists per tool.
    assert.deepEqual(Object.keys(sandboxed.outcomes).sort(), plain.tools);
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
