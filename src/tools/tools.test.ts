import assert from "node:assert";
import { describe, it } from "node:test";
import { buildTools } from "./build.js";
import { ipcTools } from "./ipc.js";
import { migrationTools } from "./migration.js";
import { performanceTools } from "./performance.js";
import { referenceTools } from "./reference.js";
import { securityTools } from "./security.js";

const allTools = [
  ...ipcTools,
  ...securityTools,
  ...buildTools,
  ...migrationTools,
  ...performanceTools,
  ...referenceTools,
];

describe("tool registration", () => {
  it("exports 17 tools", () => {
    assert.strictEqual(allTools.length, 17);
  });

  it("all tools have unique names", () => {
    const names = allTools.map((t) => t.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it("all tool names are prefixed with electron_", () => {
    for (const tool of allTools) {
      assert.ok(tool.name.startsWith("electron_"), `${tool.name} missing electron_ prefix`);
    }
  });

  it("all tools have required fields", () => {
    for (const tool of allTools) {
      assert.ok(tool.name, "tool missing name");
      assert.ok(tool.description, `${tool.name} missing description`);
      assert.ok(tool.annotations, `${tool.name} missing annotations`);
      assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
      assert.ok(typeof tool.handler === "function", `${tool.name} handler is not a function`);
    }
  });

  it("all tools have MCP annotations", () => {
    for (const tool of allTools) {
      assert.strictEqual(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
      assert.strictEqual(typeof tool.annotations.destructiveHint, "boolean", `${tool.name} missing destructiveHint`);
      assert.strictEqual(typeof tool.annotations.idempotentHint, "boolean", `${tool.name} missing idempotentHint`);
      assert.strictEqual(typeof tool.annotations.openWorldHint, "boolean", `${tool.name} missing openWorldHint`);
    }
  });

  it("all tools are read-only and non-destructive", () => {
    for (const tool of allTools) {
      assert.strictEqual(tool.annotations.readOnlyHint, true, `${tool.name} should be readOnly`);
      assert.strictEqual(tool.annotations.destructiveHint, false, `${tool.name} should not be destructive`);
    }
  });
});

describe("electron_scaffold_ipc_channel", () => {
  const tool = allTools.find((t) => t.name === "electron_scaffold_ipc_channel")!;

  it("generates IPC boilerplate for renderer-to-main invoke", async () => {
    const result = (await tool.handler({
      channelName: "get-user",
      direction: "renderer-to-main",
      description: "Fetches user data",
      args: "{ userId: string }",
      returnType: "{ name: string }",
    })) as string;

    assert.ok(result.includes("ipcMain.handle"));
    assert.ok(result.includes("ipcRenderer.invoke"));
    assert.ok(result.includes("contextBridge"));
    assert.ok(result.includes("get-user"));
    assert.ok(result.includes("getUser"));
  });
});

describe("electron_audit_security", () => {
  const tool = allTools.find((t) => t.name === "electron_audit_security")!;

  it("detects nodeIntegration: true", async () => {
    const result = (await tool.handler({
      browserWindowConfig: "{ webPreferences: { nodeIntegration: true } }",
    })) as string;

    assert.ok(result.includes("FAIL"));
    assert.ok(result.includes("nodeIntegration"));
  });

  it("passes clean config", async () => {
    const result = (await tool.handler({
      browserWindowConfig: "{ webPreferences: { contextIsolation: true, sandbox: true } }",
    })) as string;

    assert.ok(result.includes("PASS"));
  });
});

describe("electron_explain_concept", () => {
  const tool = allTools.find((t) => t.name === "electron_explain_concept")!;

  it("returns content for all concepts", async () => {
    const concepts = [
      "process-model",
      "context-isolation",
      "sandbox",
      "ipc",
      "asar",
      "fuses",
      "code-signing",
      "electron-forge-vs-electron-builder",
    ];
    for (const concept of concepts) {
      const result = (await tool.handler({ concept })) as string;
      assert.ok(result.length > 100, `${concept} explanation too short`);
    }
  });
});

describe("electron_migrate_version", () => {
  const tool = allTools.find((t) => t.name === "electron_migrate_version")!;

  it("lists breaking changes for 28 to 41", async () => {
    const result = (await tool.handler({ currentVersion: 28, targetVersion: 41 })) as string;

    assert.ok(result.includes("Migration"));
    assert.ok(result.includes("Breaking Changes"));
    assert.ok(result.includes("Summary"));
  });
});
