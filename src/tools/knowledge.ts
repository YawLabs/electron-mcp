import { z } from "zod";
import { KNOWLEDGE_VERSION } from "../knowledge.js";

export const knowledgeTools = [
  {
    name: "electron_knowledge_version",
    description:
      "Return metadata about the embedded Electron knowledge used by this MCP's analysis tools — the date it was last verified against official Electron docs, the current Electron stable version at that time, and the supported version range for migration/deprecation checks. Call this when you need to know whether the advice from other tools is current.",
    annotations: {
      title: "Get embedded-knowledge version",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const { lastVerified, electronStable, supportedRange, sources } = KNOWLEDGE_VERSION;
      return [
        "# Electron MCP Knowledge Metadata",
        "",
        `- **Last verified:** ${lastVerified}`,
        `- **Electron stable at verification:** v${electronStable}`,
        `- **Supported version range:** v${supportedRange.min} – v${supportedRange.max}`,
        "",
        "## Sources",
        "",
        `- Breaking changes: ${sources.breakingChanges}`,
        `- Security recommendations: ${sources.security}`,
        `- Performance anti-patterns: ${sources.performance}`,
        `- Release notes: ${sources.releases}`,
        "",
        "## Scope",
        "",
        "The embedded data covers:",
        "- Breaking changes and deprecated APIs across the supported version range",
        "- Security recommendations from the official checklist (20 items)",
        "- Performance anti-patterns (8 items)",
        "- Concept explanations (process model, contextIsolation, sandbox, IPC, ASAR, fuses, code signing, build tools)",
        "",
        "If the Electron stable version is higher than the one above, advice from other tools may be missing the most recent breaking changes. Cross-check with the official release notes for any version newer than the verified one.",
      ].join("\n");
    },
  },
] as const;
