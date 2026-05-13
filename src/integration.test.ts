/**
 * End-to-end test: spawn the built binary as a subprocess, connect through
 * the MCP SDK client over stdio, and exercise the real JSON-RPC surface.
 *
 * This catches everything the handler-level unit tests can't -- JSON-RPC
 * framing, tool registration, the wrapping layer in src/index.ts, the
 * knowledge-footer injection, and the version subcommand.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildTools } from "./tools/build.js";
import { ipcTools } from "./tools/ipc.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { migrationTools } from "./tools/migration.js";
import { performanceTools } from "./tools/performance.js";
import { referenceTools } from "./tools/reference.js";
import { securityTools } from "./tools/security.js";

// dist/index.js lives next to this test file (both emitted to dist/)
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));

// Compare against the sum of per-category arrays instead of a magic number
// so that adding a tool in one place doesn't require updating the test.
const EXPECTED_TOOL_COUNT =
  ipcTools.length +
  securityTools.length +
  buildTools.length +
  migrationTools.length +
  performanceTools.length +
  referenceTools.length +
  knowledgeTools.length;

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client({ name: "integration-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe("integration: stdio MCP server", () => {
  it("exposes every registered tool through tools/list", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.listTools();
      assert.strictEqual(
        res.tools.length,
        EXPECTED_TOOL_COUNT,
        `expected ${EXPECTED_TOOL_COUNT} tools, got ${res.tools.length}`,
      );
      const names = res.tools.map((t) => t.name);
      assert.ok(
        names.every((n) => n.startsWith("electron_")),
        "every tool name must be prefixed",
      );
      assert.ok(names.includes("electron_knowledge_version"));
    } finally {
      await close();
    }
  });

  it("tools/call invokes a handler and returns text content", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: "electron_audit_security",
        arguments: {
          browserWindowConfig: "{ webPreferences: { nodeIntegration: true } }",
        },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      assert.strictEqual(content[0].type, "text");
      assert.ok(content[0].text.includes("FAIL"), "expected FAIL in nodeIntegration: true audit");
    } finally {
      await close();
    }
  });

  it("injects the knowledge footer into regular tool output", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: "electron_explain_concept",
        arguments: { concept: "sandbox" },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      assert.ok(content[0].text.includes("Knowledge last verified"), "footer must be appended");
      assert.ok(content[0].text.includes("2026-04-13"), "footer must include the verification date");
    } finally {
      await close();
    }
  });

  it("knowledge-version tool is exempt from the footer", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: "electron_knowledge_version",
        arguments: {},
      });
      const content = res.content as Array<{ type: string; text: string }>;
      // The metadata itself mentions the date in the body; the exemption check
      // is that the footer marker is not duplicated at the end.
      const text = content[0].text;
      const footerMarker = "_Knowledge last verified";
      assert.ok(!text.includes(footerMarker), "knowledge-version must not self-footer");
    } finally {
      await close();
    }
  });

  it("surfaces an actionable error that names the failing field on invalid input", async () => {
    const { client, close } = await connect();
    try {
      let sawError = false;
      let message = "";
      try {
        const res = await client.callTool({
          name: "electron_migrate_version",
          arguments: { currentVersion: "not a number", targetVersion: 41 },
        });
        // SDK may resolve with isError + content, or with a protocol-level error
        sawError = res.isError === true;
        const content = res.content as Array<{ type: string; text: string }> | undefined;
        message = content?.[0]?.text ?? "";
      } catch (err) {
        sawError = true;
        message = err instanceof Error ? err.message : String(err);
      }
      assert.ok(sawError, `expected validation failure to surface as an error; got: ${message}`);
      // SDK-version-tolerant: a useful zod error names the field, the bad
      // value, or the word "validation"/"invalid". Accept any of these
      // so the test stays meaningful across SDK formatting changes without
      // re-breaking on every minor SDK release. If the SDK ever switches
      // to opaque error messages, swap this for inspection of the
      // structured error response.
      const isActionable =
        /currentVersion/i.test(message) ||
        /not\s*a\s*number/i.test(message) ||
        /(?:invalid|validation|expected)/i.test(message);
      assert.ok(isActionable, `error must indicate validation failure with actionable detail; got: ${message}`);
    } finally {
      await close();
    }
  });

  it("version subcommand prints the package version and exits", () => {
    const out = execFileSync(process.execPath, [serverPath, "version"], { encoding: "utf-8" }).trim();
    assert.ok(/^\d+\.\d+\.\d+/.test(out), `expected semver, got: ${out}`);
  });

  it("rejects unknown subcommands instead of hanging on stdin", () => {
    // Regression guard: a typo (`electron-mcp versoin`) previously fell
    // through to the MCP server, which blocks on stdio and looks like a
    // hang to the user. The CLI now errors out non-interactively.
    let exited = false;
    let stderr = "";
    try {
      execFileSync(process.execPath, [serverPath, "versoin"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        // Belt-and-braces -- if the guard regresses and the process actually
        // starts the MCP server, kill it instead of hanging the test runner.
        timeout: 5000,
      });
    } catch (err) {
      exited = true;
      const e = err as { status?: number; stderr?: string };
      stderr = e.stderr ?? "";
      assert.notStrictEqual(e.status, 0, "non-zero exit expected for unknown subcommand");
    }
    assert.ok(exited, "process must exit non-zero on unknown subcommand");
    assert.ok(/Unknown subcommand/i.test(stderr), `stderr should explain the failure; got: ${stderr}`);
  });
});
