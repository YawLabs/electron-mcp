import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stripCommentsAndStrings } from "./static-analysis.js";

/**
 * The shipped bundle's capability surface, pinned.
 *
 * The launcher's opt-in sandbox (`ELECTRON_MCP_SANDBOX=1`, see the header of
 * bin/electron-mcp.mjs) runs the server under oam's bare `--permission`, with
 * no `--allow-*` grant at all, on the claim that this server reads no file,
 * spawns no process, opens no socket and reads no environment variable. Three
 * of those four are caught at runtime if the claim ever stops being true: a
 * denied fs, child-process or net call throws ERR_ACCESS_DENIED, and
 * sandbox.test.ts sees it wherever a real oam is installed. The fourth is not:
 * under `--permission` oam hides the environment rather than refusing it, so
 * `process.env.FOO` reads as undefined and the server silently misbehaves. The
 * env leg therefore has to be pinned STATICALLY -- here -- so that a change
 * which starts reading the environment, or imports a built-in that reaches the
 * filesystem or network, fails in review rather than in a user's session.
 *
 * Bundles src/index.ts with the same options build.mjs uses, in memory, and
 * reads esbuild's metafile: that is the one place the bundle's REAL imports
 * are listed. A text scan cannot tell them apart from the `import ... from
 * "node:fs"` lines that live inside the Electron code the tools generate, as
 * text in template literals. The env scan below runs over
 * stripCommentsAndStrings(bundle) for the same reason: it removes every
 * string and template body and leaves only code this process would execute.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Built-in modules the bundle is allowed to import. Exactly these, no more. */
const ALLOWED_BUILTINS = ["node:module", "node:process"];

/** Built-ins whose mere import would widen the surface the sandbox denies. */
const CAPABILITY_BUILTINS = [
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "tls",
  "vm",
  "worker_threads",
];

type Bundle = { text: string; externals: string[] };

async function bundleServer(): Promise<Bundle> {
  // Mirrors build.mjs: bundle, platform node, ESM, __VERSION__ defined. Kept
  // in step by hand; the assertions below are about what src/ pulls in, which
  // no build option changes.
  const result = await build({
    entryPoints: [resolve(repoRoot, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    define: { __VERSION__: JSON.stringify("0.0.0-test") },
  });
  const output = Object.values(result.metafile.outputs)[0];
  const externals = output.imports
    .filter((i) => i.external)
    .map((i) => i.path)
    .sort();
  return { text: result.outputFiles[0].text, externals };
}

describe("shipped bundle capability surface", () => {
  const bundled = bundleServer();

  it("imports exactly the built-ins the sandbox rationale names", async () => {
    // `node:process` is the MCP SDK's stdio transport; `node:module` is the
    // createRequire import in src/version.ts, never called in the bundle
    // because esbuild substitutes __VERSION__. Anything new here is a real
    // change to what the server can touch, and the launcher header, README and
    // CHANGELOG all describe this exact list.
    const { externals } = await bundled;
    assert.deepEqual(externals, ALLOWED_BUILTINS);
  });

  it("imports no capability-bearing built-in under any spelling", async () => {
    // Bare `fs` and `node:fs` resolve to the same module; the allow-list above
    // is prefixed, so also refuse the bare spellings explicitly.
    const { externals } = await bundled;
    const specifiers = new Set(externals);
    for (const name of CAPABILITY_BUILTINS) {
      assert.equal(specifiers.has(name), false, `bundle imports "${name}"`);
      assert.equal(specifiers.has(`node:${name}`), false, `bundle imports "node:${name}"`);
    }
  });

  it("reads no environment variable in executable code", async () => {
    // Generated Electron code mentions process.env inside template literals;
    // stripping strings leaves only what this process itself would run.
    const { text } = await bundled;
    const reads = [...stripCommentsAndStrings(text).matchAll(/process\.env\b/g)].length;
    assert.equal(reads, 0, `found ${reads} process.env read(s) in executable bundle code`);
  });

  it("control: the raw bundle DOES mention process.env, so the scrub is what makes the check pass", async () => {
    // Without this the previous test would also pass for a scanner that never
    // saw the bundle at all.
    const { text } = await bundled;
    assert.ok(/process\.env\b/.test(text), "expected generated-code mentions of process.env in the raw bundle");
  });
});
