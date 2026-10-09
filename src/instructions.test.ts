import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { buildTools } from "./tools/build.js";
import { ipcTools } from "./tools/ipc.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { migrationTools } from "./tools/migration.js";
import { performanceTools } from "./tools/performance.js";
import { referenceTools } from "./tools/reference.js";
import { securityTools } from "./tools/security.js";

// Yaw MCP renders a server's `instructions` once per session and truncates
// anything over MAX_UPSTREAM_INSTRUCTIONS_BYTES = 2000 (yaw-mcp
// src/upstream-instructions.ts). A string past the cap loses its tail
// silently, so the ceiling is pinned here rather than remembered.
const MAX_INSTRUCTIONS_BYTES = 2000;

describe("server instructions", () => {
  it("stays under the 2000-byte ceiling hosts render", () => {
    const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8");
    assert.ok(bytes > 0, "instructions must not be empty");
    assert.ok(
      bytes < MAX_INSTRUCTIONS_BYTES,
      `instructions are ${bytes} bytes; the ceiling is ${MAX_INSTRUCTIONS_BYTES}`,
    );
  });

  it("is plain ASCII", () => {
    assert.match(SERVER_INSTRUCTIONS, /^[\x20-\x7e\n]*$/, "instructions must be printable ASCII and newlines only");
  });

  it("names only tools this server registers, and every one of them", () => {
    const registered = new Set<string>(
      [
        ...ipcTools,
        ...securityTools,
        ...buildTools,
        ...migrationTools,
        ...performanceTools,
        ...referenceTools,
        ...knowledgeTools,
      ].map((tool) => tool.name),
    );
    const named = new Set(SERVER_INSTRUCTIONS.match(/\belectron_[a-z_]+/g) ?? []);
    for (const name of named) assert.ok(registered.has(name), `instructions name an unknown tool: ${name}`);
    for (const name of registered) assert.ok(named.has(name), `instructions do not route to ${name}`);
  });
});
