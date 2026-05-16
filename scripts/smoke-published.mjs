// Thick smoke against the published tarball.
//
// Goes beyond the release.yml smoke (which only checks `--version`):
// connects to the MCP server over stdio, handshakes, lists tools, and
// calls representative tools end to end. If a tool file was dropped by
// esbuild or the SDK contract broke at the wire level, this catches it.
//
// Usage:
//   node scripts/smoke-published.mjs                    # smokes this repo's version
//   SMOKE_VERSION=1.2.4 node scripts/smoke-published.mjs # smoke a specific version
//   SMOKE_INSTALL_DIR=/path node scripts/smoke-published.mjs
//     # skip self-install and reuse a pre-installed dir (debugging)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { version: localVersion } = require("../package.json");
const VERSION = process.env.SMOKE_VERSION ?? localVersion;

// Validate before we hand `VERSION` to a shell. Without this guard, a value
// like `1.0.0; rm -rf ~` interpolated into the `npm install ${PKG}` argv
// below would actually execute the rm half. The check accepts the npm-version
// character set (digits, letters, dots, dashes, underscores, plus) and
// rejects anything else -- spaces, quotes, shell metacharacters, newlines.
//
// First char must NOT be `-`: otherwise `--registry=http://attacker` would
// pass (single argv token, but a flag-shaped one that npm would parse as an
// argument rather than a version spec).
if (!/^[\w.+][\w.+-]*$/.test(VERSION)) {
  console.error(`Invalid SMOKE_VERSION: ${JSON.stringify(VERSION)} -- must match /^[\\w.+][\\w.+-]*$/`);
  process.exit(2);
}
const PKG = `@yawlabs/electron-mcp@${VERSION}`;

console.log(`smoking ${PKG}...`);

// Resolve an install dir. If SMOKE_INSTALL_DIR is set, trust the caller
// did the install. Otherwise self-install into a fresh tempdir and clean
// up on exit. The escape hatch lets you re-run against the same install
// while iterating on the smoke logic.
const reuseInstallDir = process.env.SMOKE_INSTALL_DIR;
let installDir = reuseInstallDir;
let cleanupOnExit = false;
if (!installDir) {
  installDir = mkdtempSync(join(tmpdir(), "electron-mcp-smoke-"));
  cleanupOnExit = true;
  console.log(`  installing into ${installDir}`);
  // `npm install <pkg>` on its own writes to a parent package.json if
  // one exists -- a bare `npm init -y` first guarantees we control the
  // surrounding state.
  writeFileSync(join(installDir, "package.json"), '{"name":"smoke","version":"0.0.0","private":true}\n');
  // Going through `npm install` exercises the registry + tarball
  // resolution the way a real consumer would. Spawn synchronously --
  // the smoke is short, no parallelism to gain.
  //
  // `shell: true` resolves `npm` -> `npm.cmd` on Windows without our having
  // to hand-code the extension. Safe here ONLY because PKG was built from
  // a regex-validated VERSION above; do NOT relax that check.
  execFileSync("npm", ["install", PKG, "--silent", "--no-audit", "--no-fund"], {
    cwd: installDir,
    stdio: "inherit",
    shell: true,
  });
}

// Spawn the published entry directly. Going through `npx` would also
// exercise the bin shim, but Windows cmd-shim resolution is fragile in
// some shells (Git Bash here); the release.yml CI smoke already covers
// the npx path on Linux. Invoking `node <entry>` keeps this script
// portable.
const entry = join(installDir, "node_modules", "@yawlabs", "electron-mcp", "dist", "index.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

try {
  await client.connect(transport);
  console.log("  connected");

  // 1. tools/list returns a non-trivial count and every name prefixed.
  const { tools } = await client.listTools();
  check("tools/list returns >= 17 tools", () => {
    if (tools.length < 17) throw new Error(`got ${tools.length}`);
  });
  check("every tool name starts with electron_", () => {
    const bad = tools.map((t) => t.name).filter((n) => !n.startsWith("electron_"));
    if (bad.length) throw new Error(`bad names: ${bad.join(", ")}`);
  });

  // 2. electron_audit_security -- exercises a non-trivial tool, confirms
  //    the audit report shape and that nodeIntegration: true is still
  //    flagged as a FAIL post-publish.
  const auditRes = await client.callTool({
    name: "electron_audit_security",
    arguments: { browserWindowConfig: "{ webPreferences: { nodeIntegration: true } }" },
  });
  const auditText = auditRes.content[0].text;
  check("audit_security flags nodeIntegration: true as FAIL", () => {
    if (!auditText.includes("FAIL")) throw new Error("no FAIL in report");
    if (!auditText.includes("nodeIntegration")) throw new Error("nodeIntegration not mentioned");
  });
  check("audit_security report includes the knowledge footer", () => {
    if (!auditText.includes("Knowledge last verified")) throw new Error("footer missing");
  });

  // 3. electron_knowledge_version -- exercises the footer-exemption path
  //    and confirms the embedded version metadata advertises v28-v41.
  const kvRes = await client.callTool({ name: "electron_knowledge_version", arguments: {} });
  const kvText = kvRes.content[0].text;
  check("knowledge_version advertises v28-v41 supported range", () => {
    if (!/v?28/.test(kvText) || !/v?41/.test(kvText)) {
      throw new Error(`range not found in: ${kvText.slice(0, 200)}`);
    }
  });
  check("knowledge_version is exempt from the footer (no duplicate)", () => {
    if (/_Knowledge last verified/.test(kvText)) throw new Error("self-footered");
  });

  // 4. electron_check_deprecated_apis -- proves the version-filter fix
  //    from this release: session.loadExtension on v28 should NOT be flagged.
  const depRes = await client.callTool({
    name: "electron_check_deprecated_apis",
    arguments: {
      code: "session.loadExtension('/path/to/ext');",
      electronVersion: 28,
    },
  });
  const depText = depRes.content[0].text;
  check("check_deprecated_apis respects electronVersion (v28 lift on v36 deprecation)", () => {
    if (!depText.includes("CLEAN")) {
      throw new Error(`expected CLEAN on v28 for v36-deprecated API; got: ${depText.slice(0, 200)}`);
    }
  });
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
  if (cleanupOnExit) {
    try {
      rmSync(installDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`  warn: failed to clean up ${installDir}: ${err.message}`);
    }
  }
}

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED against ${PKG}`);
