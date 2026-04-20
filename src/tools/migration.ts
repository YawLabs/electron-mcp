import { z } from "zod";

// Major breaking changes by Electron version
const breakingChanges: Record<number, Array<{ change: string; migration: string; severity: string }>> = {
  28: [
    {
      change:
        "BrowserWindow.setTrafficLightPosition() / getTrafficLightPosition() renamed to setWindowButtonPosition() / getWindowButtonPosition()",
      migration:
        "Rename method calls from setTrafficLightPosition/getTrafficLightPosition to setWindowButtonPosition/getWindowButtonPosition.",
      severity: "LOW",
    },
    {
      change: "WebContentsView replaces BrowserView",
      migration: "Migrate from BrowserView to WebContentsView. WebContentsView uses a more flexible layout system.",
      severity: "MEDIUM",
    },
  ],
  29: [
    {
      change: "webContents.getPrintersAsync() replaces webContents.getPrinters()",
      migration: "Replace synchronous getPrinters() with async getPrintersAsync() and await the result.",
      severity: "LOW",
    },
    {
      change: "ipcRenderer.sendTo() removed",
      migration: "Use MessagePort-based communication between renderers instead of ipcRenderer.sendTo().",
      severity: "MEDIUM",
    },
  ],
  30: [
    {
      change: "webContents.backgroundThrottling default changed to true",
      migration:
        "If your app relies on background processing in renderers, explicitly set backgroundThrottling: false in webPreferences.",
      severity: "LOW",
    },
    {
      change: "BrowserView deprecated",
      migration:
        "Migrate to WebContentsView + BaseWindow. BrowserView is still functional but no longer receiving improvements.",
      severity: "MEDIUM",
    },
  ],
  31: [
    {
      change: "Extended WebContentsView API",
      migration: "If using BrowserView, now is a good time to migrate to WebContentsView which has feature parity.",
      severity: "LOW",
    },
  ],
  32: [
    {
      change: "app.runningUnderARM64Translation renamed to app.runningUnderTranslation",
      migration: "Rename any references from runningUnderARM64Translation to runningUnderTranslation.",
      severity: "LOW",
    },
  ],
  33: [
    {
      change: "macOS 10.15 (Catalina) support dropped",
      migration: "Minimum macOS version is now 11.0 (Big Sur). Update your documentation and CI build targets.",
      severity: "MEDIUM",
    },
    {
      change: "systemPreferences.isInvertedColorScheme() and systemPreferences.isHighContrastColorScheme() removed",
      migration: "Use nativeTheme.shouldUseInvertedColorScheme and nativeTheme.shouldUseHighContrastColors instead.",
      severity: "LOW",
    },
  ],
  34: [
    {
      change: "session.setPermissionCheckHandler callback signature changed",
      migration: "Update permission check handlers to use the new signature with additional parameters.",
      severity: "LOW",
    },
  ],
  35: [
    {
      change: "webRequest filter URLs now strictly validated",
      migration:
        "Ensure all URL patterns in webRequest filters are valid. Invalid patterns now throw instead of silently failing.",
      severity: "LOW",
    },
  ],
  36: [
    {
      change: "File drag events require explicit permission",
      migration: "Add webContents.startDrag() calls with proper file paths and icons for file drag operations.",
      severity: "LOW",
    },
  ],
  37: [
    {
      change: "session.loadExtension() moved to session.extensions.loadExtension()",
      migration: "Update extension loading calls from session.loadExtension() to session.extensions.loadExtension().",
      severity: "LOW",
    },
  ],
  38: [
    {
      change: "macOS 11 (Big Sur) support dropped",
      migration: "Minimum macOS version is now 12.0 (Monterey). Update build targets and documentation.",
      severity: "MEDIUM",
    },
    {
      change: "Clipboard access deprecated from renderer process",
      migration: "Move clipboard operations to the main process and expose them via IPC through the preload bridge.",
      severity: "MEDIUM",
    },
  ],
  39: [
    {
      change: "Popup windows (window.open) are always resizable regardless of parent config",
      migration:
        "If you need non-resizable popups, use setWindowOpenHandler to create custom BrowserWindows instead of window.open().",
      severity: "LOW",
    },
  ],
  40: [
    {
      change: "Renderer-process clipboard access fully removed",
      migration:
        "All clipboard operations must go through the main process via IPC. Create preload bridge methods for clipboard read/write.",
      severity: "MEDIUM",
    },
  ],
  41: [
    {
      change: "WebContentsView fully replaces BrowserView (BrowserView may be removed in future)",
      migration: "If still using BrowserView, migrate to WebContentsView now. The API is stable and feature-complete.",
      severity: "MEDIUM",
    },
  ],
};

// Deprecated APIs by version they were deprecated
const deprecatedApis: Array<{ api: string; deprecated: number; removed?: number; replacement: string }> = [
  { api: "BrowserView", deprecated: 30, replacement: "WebContentsView + BaseWindow" },
  { api: "ipcRenderer.sendTo()", deprecated: 28, removed: 29, replacement: "MessagePort / MessageChannelMain" },
  { api: "webContents.getPrinters()", deprecated: 28, removed: 29, replacement: "webContents.getPrintersAsync()" },
  {
    api: "systemPreferences.isInvertedColorScheme()",
    deprecated: 32,
    removed: 33,
    replacement: "nativeTheme.shouldUseInvertedColorScheme",
  },
  {
    api: "systemPreferences.isHighContrastColorScheme()",
    deprecated: 32,
    removed: 33,
    replacement: "nativeTheme.shouldUseHighContrastColors",
  },
  { api: "app.runningUnderARM64Translation", deprecated: 31, removed: 32, replacement: "app.runningUnderTranslation" },
  { api: "session.loadExtension()", deprecated: 36, removed: 37, replacement: "session.extensions.loadExtension()" },
  {
    api: "clipboard (renderer process)",
    deprecated: 38,
    removed: 40,
    replacement: "IPC bridge to main process clipboard",
  },
  { api: "@electron/remote", deprecated: 14, replacement: "Explicit IPC via ipcMain.handle() + ipcRenderer.invoke()" },
  {
    api: "BrowserWindow.setTrafficLightPosition()",
    deprecated: 27,
    removed: 28,
    replacement: "BrowserWindow.setWindowButtonPosition()",
  },
  { api: "new-window event", deprecated: 24, replacement: "webContents.setWindowOpenHandler()" },
];

export const migrationTools = [
  {
    name: "electron_migrate_version",
    description:
      "Generate a migration checklist for upgrading between Electron versions. Lists all breaking changes, deprecated APIs, and required code modifications between the current and target versions.",
    annotations: {
      title: "Migrate Electron version",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      currentVersion: z.number().int().min(28).max(41).describe("Current Electron major version (e.g. 28)"),
      targetVersion: z.number().int().min(28).max(41).describe("Target Electron major version (e.g. 41)"),
    }),
    handler: async (input: { currentVersion: number; targetVersion: number }) => {
      if (input.currentVersion >= input.targetVersion) {
        return "Target version must be higher than current version.";
      }

      const sections: string[] = [];
      sections.push(`# Electron Migration: v${input.currentVersion} → v${input.targetVersion}\n`);

      let totalChanges = 0;
      let mediumOrHighChanges = 0;

      for (let v = input.currentVersion + 1; v <= input.targetVersion; v++) {
        const changes = breakingChanges[v];
        if (changes && changes.length > 0) {
          sections.push(`## v${v} Breaking Changes\n`);
          for (const c of changes) {
            sections.push(`### [${c.severity}] ${c.change}\n\n${c.migration}\n`);
            totalChanges++;
            if (c.severity === "MEDIUM" || c.severity === "HIGH") mediumOrHighChanges++;
          }
        }
      }

      // Check deprecated APIs that become removed in the range
      const affectedDeprecations = deprecatedApis.filter((d) => {
        if (d.removed && d.removed > input.currentVersion && d.removed <= input.targetVersion) return true;
        if (d.deprecated > input.currentVersion && d.deprecated <= input.targetVersion) return true;
        return false;
      });

      if (affectedDeprecations.length > 0) {
        sections.push("## Deprecated APIs\n");
        sections.push("| API | Status | Replacement |");
        sections.push("|-----|--------|-------------|");
        for (const d of affectedDeprecations) {
          const status =
            d.removed && d.removed <= input.targetVersion
              ? `Removed in v${d.removed}`
              : `Deprecated in v${d.deprecated}`;
          sections.push(`| \`${d.api}\` | ${status} | ${d.replacement} |`);
        }
        sections.push("");
      }

      // Platform support changes
      const platformChanges: string[] = [];
      if (input.currentVersion < 33 && input.targetVersion >= 33) {
        platformChanges.push("- macOS 10.15 (Catalina) support dropped in v33 — minimum is now macOS 11 (Big Sur)");
      }
      if (input.currentVersion < 38 && input.targetVersion >= 38) {
        platformChanges.push("- macOS 11 (Big Sur) support dropped in v38 — minimum is now macOS 12 (Monterey)");
      }

      if (platformChanges.length > 0) {
        sections.push(`## Platform Support Changes\n\n${platformChanges.join("\n")}\n`);
      }

      // Summary
      const defaultChanges = breakingChanges[input.currentVersion + 1] !== undefined || totalChanges > 0;
      if (!defaultChanges && affectedDeprecations.length === 0 && platformChanges.length === 0) {
        sections.push(
          "No breaking changes recorded for this version range. Check the official Electron release notes for any unlisted changes.\n",
        );
      }

      sections.push(
        `---\n\n**Summary:** ${totalChanges} breaking change(s), ${affectedDeprecations.length} deprecated API(s), ${platformChanges.length} platform change(s). ${mediumOrHighChanges > 0 ? `${mediumOrHighChanges} change(s) require significant code updates.` : "Most changes are minor."}`,
      );
      sections.push("\nAlways check the official release notes: https://releases.electronjs.org");

      return sections.join("\n");
    },
  },

  {
    name: "electron_check_deprecated_apis",
    description:
      "Scan code for usage of deprecated or removed Electron APIs. Returns a list of deprecated APIs found with their replacements and the version they were deprecated/removed in.",
    annotations: {
      title: "Check for deprecated APIs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      code: z.string().max(500_000).describe("Source code to scan for deprecated API usage"),
      electronVersion: z
        .number()
        .int()
        .optional()
        .describe("Current Electron major version to determine what's deprecated (default: 41)"),
    }),
    handler: async (input: { code: string; electronVersion?: number }) => {
      const ver = input.electronVersion || 41;
      const code = input.code;
      const found: Array<{ api: string; deprecated: number; removed?: number; replacement: string }> = [];

      const patterns: Array<{ pattern: RegExp; api: string }> = [
        {
          pattern: /new\s+BrowserView\s*\(|BrowserView\.fromWebContents|BrowserView\.getAllViews/g,
          api: "BrowserView",
        },
        { pattern: /ipcRenderer\.sendTo\s*\(/g, api: "ipcRenderer.sendTo()" },
        { pattern: /\.getPrinters\s*\(\)/g, api: "webContents.getPrinters()" },
        { pattern: /systemPreferences\.isInvertedColorScheme\s*\(/g, api: "systemPreferences.isInvertedColorScheme()" },
        {
          pattern: /systemPreferences\.isHighContrastColorScheme\s*\(/g,
          api: "systemPreferences.isHighContrastColorScheme()",
        },
        { pattern: /runningUnderARM64Translation/g, api: "app.runningUnderARM64Translation" },
        { pattern: /session\.loadExtension\s*\(/g, api: "session.loadExtension()" },
        { pattern: /require\s*\(\s*['"]@electron\/remote['"]\s*\)/g, api: "@electron/remote" },
        {
          pattern: /setTrafficLightPosition\s*\(|getTrafficLightPosition\s*\(/g,
          api: "BrowserWindow.setTrafficLightPosition()",
        },
        { pattern: /\.on\s*\(\s*['"]new-window['"]/g, api: "new-window event" },
      ];

      for (const { pattern, api } of patterns) {
        if (pattern.test(code)) {
          const entry = deprecatedApis.find((d) => d.api === api);
          if (entry) {
            found.push(entry);
          }
        }
      }

      if (found.length === 0) {
        return `# Deprecated API Check: CLEAN\n\nNo deprecated Electron APIs found in the code (checked against Electron v${ver}).`;
      }

      let report = `# Deprecated API Check: ${found.length} ISSUE(S)\n\n`;
      report += "| API | Status | Replacement |\n";
      report += "|-----|--------|-------------|\n";

      for (const f of found) {
        const isRemoved = f.removed && f.removed <= ver;
        const status = isRemoved ? `REMOVED in v${f.removed}` : `Deprecated since v${f.deprecated}`;
        report += `| \`${f.api}\` | ${status} | ${f.replacement} |\n`;
      }

      const removedCount = found.filter((f) => f.removed && f.removed <= ver).length;
      if (removedCount > 0) {
        report += `\n**${removedCount} API(s) have been REMOVED** and will cause runtime errors. These must be fixed before upgrading.\n`;
      }

      return report;
    },
  },
] as const;
