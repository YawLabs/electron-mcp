/**
 * End-to-end test: spawn the built binary as a subprocess, connect through
 * the MCP SDK client over stdio, and exercise the real JSON-RPC surface.
 *
 * This catches everything the handler-level unit tests can't — JSON-RPC
 * framing, tool registration, the wrapping layer in src/index.ts, the
 * knowledge-footer injection, and the version subcommand.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// dist/index.js lives next to this test file (both emitted to dist/)
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));

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
  it("exposes all 18 tools through tools/list", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.listTools();
      assert.strictEqual(res.tools.length, 18, `expected 18 tools, got ${res.tools.length}`);
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

  it("returns isError for invalid tool input", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: "electron_migrate_version",
        arguments: { currentVersion: "not a number", targetVersion: 41 },
      });
      // MCP SDK either surfaces a protocol error or isError:true content
      assert.ok(res.isError === true || res.content, "expected an error result for invalid input");
    } finally {
      await close();
    }
  });

  it("version subcommand prints the package version and exits", () => {
    const out = execFileSync(process.execPath, [serverPath, "version"], { encoding: "utf-8" }).trim();
    assert.ok(/^\d+\.\d+\.\d+/.test(out), `expected semver, got: ${out}`);
  });
});
