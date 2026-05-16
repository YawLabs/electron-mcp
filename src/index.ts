#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { knowledgeFooter } from "./knowledge.js";
import { buildTools } from "./tools/build.js";
import { ipcTools } from "./tools/ipc.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { migrationTools } from "./tools/migration.js";
import { performanceTools } from "./tools/performance.js";
import { referenceTools } from "./tools/reference.js";
import { securityTools } from "./tools/security.js";
import { resolveVersion } from "./version.js";

const version = resolveVersion();

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// Reject unknown subcommands instead of silently starting the stdio MCP
// server. Without this guard, a typo like `electron-mcp versoin` would block
// on stdin forever while the user wonders why their command hangs. The MCP
// server starts only when no positional argument is provided.
if (subcommand !== undefined) {
  console.error(`Unknown subcommand: ${subcommand}\nUsage: electron-mcp [version|--version]`);
  process.exit(1);
}

// ─── No subcommand -- start the MCP server ───

const allTools = [
  ...ipcTools,
  ...securityTools,
  ...buildTools,
  ...migrationTools,
  ...performanceTools,
  ...referenceTools,
  ...knowledgeTools,
];

// The knowledge-version tool IS the metadata -- don't self-annotate it.
const FOOTER_EXEMPT = new Set(["electron_knowledge_version"]);

const server = new McpServer({
  name: "@yawlabs/electron-mcp",
  version,
});

// Register all tools with annotations
for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
        // The knowledge footer is markdown text and is only safe to append
        // to string returns -- appending it to a JSON-stringified payload
        // would corrupt the structure. Tools that return non-string values
        // are exempted automatically; tools that return strings but should
        // skip the footer (the metadata tool itself) opt out via
        // FOOTER_EXEMPT. All current tools return strings; this guard is
        // here so a future structured-return tool doesn't ship a broken
        // payload.
        const isString = typeof result === "string";
        const raw = isString ? result : JSON.stringify(result, null, 2);
        const text = isString && !FOOTER_EXEMPT.has(tool.name) ? raw + knowledgeFooter() : raw;
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
