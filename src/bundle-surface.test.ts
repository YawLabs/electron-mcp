import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

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
 * text in template literals. The env scan below parses the bundle with the
 * TypeScript compiler for the same reason: only a real parse separates a
 * `process.env` read in code from the same characters inside a template
 * literal or a regex. (The repo's own lexical scrubber cannot: a regex
 * literal containing a quote flips its string/code state and blinds it to
 * whole handlers.)
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
  // One entry per importing module; two files importing node:process is not
  // a capability change, so de-duplicate before pinning.
  const externals = [...new Set(output.imports.filter((i) => i.external).map((i) => i.path))].sort();
  return { text: result.outputFiles[0].text, externals };
}

type AstCounts = { envReads: number; createRequireCalls: number };

/** Walk the bundle's AST and count the two shapes the sandbox rationale rests on. */
function countInAst(text: string): AstCounts {
  const source = ts.createSourceFile("bundle.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const counts: AstCounts = { envReads: 0, createRequireCalls: 0 };
  const isIdentifier = (node: ts.Node, name: string) => ts.isIdentifier(node) && node.text === name;
  const visit = (node: ts.Node) => {
    // process.env and process["env"], as a property access in executable code.
    if (ts.isPropertyAccessExpression(node) && isIdentifier(node.expression, "process") && node.name.text === "env") {
      counts.envReads++;
    }
    if (
      ts.isElementAccessExpression(node) &&
      isIdentifier(node.expression, "process") &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "env"
    ) {
      counts.envReads++;
    }
    if (ts.isCallExpression(node) && isIdentifier(node.expression, "createRequire")) counts.createRequireCalls++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
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
    // the AST walk sees only what this process itself would run.
    const { text } = await bundled;
    const { envReads } = countInAst(text);
    assert.equal(envReads, 0, `found ${envReads} process.env read(s) in executable bundle code`);
  });

  it("calls createRequire exactly once, in the dead tsc-only version fallback", async () => {
    // `node:module` is on the allow-list only for resolveVersionFromPackageJson,
    // whose call site the bundle still carries behind the folded __VERSION__
    // check. A second call would be a way to reach the filesystem with no new
    // import statement for the pin above to see, so the count is pinned too.
    const { text } = await bundled;
    const { createRequireCalls } = countInAst(text);
    assert.equal(createRequireCalls, 1, `expected exactly one createRequire() call, found ${createRequireCalls}`);
  });

  it("control: the raw bundle DOES mention process.env, so the parse is what makes the check pass", async () => {
    // Without this the env test would also pass for a walker that never saw
    // the bundle at all. And the walker must see through the same text: a
    // template literal containing `process.env.X` counts zero, a real read one.
    const { text } = await bundled;
    assert.ok(/process\.env\b/.test(text), "expected generated-code mentions of process.env in the raw bundle");
    assert.equal(countInAst("const s = `process.env.HOME`; const r = /['\"]x['\"]/;").envReads, 0);
    assert.equal(countInAst("const r = /['\"]x['\"]/; const h = process.env.HOME;").envReads, 1);
    assert.equal(countInAst('const h = process["env"].HOME;').envReads, 1);
  });
});
