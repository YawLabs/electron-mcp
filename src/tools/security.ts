import { z } from "zod";
import { KNOWLEDGE_VERSION } from "../knowledge.js";
import { stripComments, stripCommentsAndStrings, unsafeOpenExternalCallSites } from "../static-analysis.js";

// Electron's support policy: current stable + previous two majors receive
// security patches. Derive the supported floor from the embedded knowledge
// vintage so advice stays accurate after a knowledge bump.
const SUPPORTED_MIN = KNOWLEDGE_VERSION.electronStable - 2;
const SUPPORTED_MAX = KNOWLEDGE_VERSION.electronStable;

export const securityTools = [
  {
    name: "electron_audit_security",
    description:
      "Audit an Electron app against the official security checklist. Covers 19 of the items that can be detected from static inputs (BrowserWindow configuration, main process code, package.json, preload, HTML): HTTPS-only content, nodeIntegration, contextIsolation, sandbox, webSecurity, CSP, allowRunningInsecureContent, experimentalFeatures, enableBlinkFeatures, raw ipcRenderer exposure, direct window assignment, @electron/remote, supported Electron version, shell.openExternal validation, file:// usage, <webview> tag, will-navigate handler, setWindowOpenHandler, and IPC sender validation. The remaining checklist items (session permissions, fuse configuration) require runtime / packaging context and are flagged in the report's footer.",
    annotations: {
      title: "Audit app security",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      browserWindowConfig: z
        .string()
        .max(500_000)
        .optional()
        .describe("BrowserWindow constructor options as a JSON string or code snippet"),
      mainCode: z
        .string()
        .max(500_000)
        .optional()
        .describe("Main process code -- used to detect non-HTTPS URLs in loadURL/loadFile calls"),
      packageJson: z
        .string()
        .max(500_000)
        .optional()
        .describe("Content of package.json to check Electron version and dependencies"),
      preloadCode: z.string().max(500_000).optional().describe("Content of the preload script"),
      htmlContent: z.string().max(500_000).optional().describe("Content of the main HTML file to check CSP meta tags"),
      electronVersion: z
        .string()
        .max(20)
        .optional()
        .describe("Electron major version if not in package.json (e.g. '41')"),
    }),
    handler: async (input: {
      browserWindowConfig?: string;
      mainCode?: string;
      packageJson?: string;
      preloadCode?: string;
      htmlContent?: string;
      electronVersion?: string;
    }) => {
      const checks: Array<{ id: number; name: string; status: string; detail: string }> = [];
      const bwConfig = input.browserWindowConfig || "";
      // Strip comments from JS-shaped inputs before scanning so docstrings
      // and inline notes don't trigger false positives. HTML is left alone
      // because the CSP / <webview> checks need to see the raw markup.
      const mainCode = input.mainCode ? stripComments(input.mainCode) : "";
      const pkgJson = input.packageJson || "";
      const preload = input.preloadCode ? stripComments(input.preloadCode) : "";
      const html = input.htmlContent || "";

      // Default assumes latest supported stable; overridden by explicit input
      // or extracted from package.json. Guard against NaN from malformed input.
      let ver: number = KNOWLEDGE_VERSION.electronStable;
      if (input.electronVersion) {
        const parsed = Number.parseInt(input.electronVersion, 10);
        if (Number.isFinite(parsed)) ver = parsed;
      } else if (pkgJson) {
        const match = pkgJson.match(/"electron"\s*:\s*"[^"]*?(\d+)/);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isFinite(parsed)) ver = parsed;
        }
      }

      // 1. HTTPS content -- URLs land in loadURL/loadFile calls, not in the
      // BrowserWindow constructor options. Scan whichever code inputs we have.
      const urlCarryingCode = [bwConfig, mainCode, preload, html].filter(Boolean).join("\n");
      if (urlCarryingCode) {
        const hasHttp = /http:\/\/(?!localhost|127\.0\.0\.1)/.test(urlCarryingCode);
        checks.push({
          id: 1,
          name: "Only load secure content (HTTPS)",
          status: hasHttp ? "FAIL" : "PASS",
          detail: hasHttp
            ? "Found non-HTTPS URLs in the provided code. Remote content should be loaded over HTTPS."
            : "No insecure HTTP URLs detected.",
        });
      }

      // 2. nodeIntegration
      if (bwConfig) {
        const nodeInt = /nodeIntegration\s*:\s*true/.test(bwConfig);
        checks.push({
          id: 2,
          name: "Do not enable nodeIntegration",
          status: nodeInt ? "FAIL" : "PASS",
          detail: nodeInt
            ? `CRITICAL: nodeIntegration is enabled. This gives the renderer full Node.js access -- any XSS becomes full RCE. Default is false since Electron 5.${ver >= 5 ? " You can simply remove this line." : ""}`
            : `nodeIntegration is not enabled.${ver >= 5 ? " (default: false)" : ""}`,
        });
      }

      // 3. contextIsolation
      if (bwConfig) {
        const ctxOff = /contextIsolation\s*:\s*false/.test(bwConfig);
        checks.push({
          id: 3,
          name: "Enable contextIsolation",
          status: ctxOff ? "FAIL" : "PASS",
          detail: ctxOff
            ? `contextIsolation is disabled. This allows renderer code to modify preload prototypes and intercept IPC calls. Default is true since Electron 12.${ver >= 12 ? " Remove this line to use the safe default." : " Explicitly set contextIsolation: true."}`
            : `contextIsolation is enabled.${ver >= 12 ? " (default: true)" : ""}`,
        });
      }

      // 4. sandbox
      if (bwConfig) {
        const sandboxOff = /sandbox\s*:\s*false/.test(bwConfig);
        checks.push({
          id: 4,
          name: "Enable sandbox",
          status: sandboxOff ? "WARN" : "PASS",
          detail: sandboxOff
            ? `Sandbox is explicitly disabled. This gives the preload script full Node.js access. Default is true since Electron 20.${ver >= 20 ? " Remove sandbox: false unless you have a specific need for unsandboxed preload." : " Consider enabling sandbox: true."}`
            : `Sandbox is enabled.${ver >= 20 ? " (default: true)" : ""}`,
        });
      }

      // 5. webSecurity
      if (bwConfig) {
        const webSecOff = /webSecurity\s*:\s*false/.test(bwConfig);
        checks.push({
          id: 5,
          name: "Do not disable webSecurity",
          status: webSecOff ? "FAIL" : "PASS",
          detail: webSecOff
            ? "CRITICAL: webSecurity is disabled. This disables same-origin policy and allows loading of insecure content. Never disable this in production."
            : "webSecurity is not disabled.",
        });
      }

      // 6. CSP -- accept either an HTML CSP meta tag or a
      // session.webRequest.onHeadersReceived call in main code that injects
      // Content-Security-Policy. The session approach is what this MCP's own
      // `electron_configure_csp` tool recommends; failing it when only
      // mainCode is provided would punish users for following best practice.
      const hasCspInHtml = html ? /content-security-policy/i.test(html) : false;
      const hasCspInSession =
        !!mainCode &&
        /session\.[\w.]+\.webRequest\.onHeadersReceived/i.test(mainCode) &&
        /["']Content-Security-Policy["']/i.test(mainCode);
      // Trigger only when we actually saw a CSP signal, or when HTML was
      // provided at all (so a missing CSP in HTML still surfaces as FAIL).
      if (html || hasCspInSession) {
        const hasCSP = hasCspInHtml || hasCspInSession;
        // Unsafe-directive scan applies only to HTML; the literal value
        // passed to onHeadersReceived isn't reliably recoverable by a regex.
        const hasUnsafeInline = html ? /unsafe-inline/.test(html) : false;
        const hasUnsafeEval = html ? /unsafe-eval/.test(html) : false;
        // Collect every unsafe directive present so the status reflects ALL
        // weaknesses, not just unsafe-eval. Previously unsafe-inline only
        // surfaced inside the unsafe-eval branch's message string, so a CSP
        // with unsafe-inline alone incorrectly reported PASS.
        const unsafeDirectives: string[] = [];
        if (hasUnsafeEval) unsafeDirectives.push("'unsafe-eval'");
        if (hasUnsafeInline) unsafeDirectives.push("'unsafe-inline'");
        checks.push({
          id: 6,
          name: "Define a Content Security Policy",
          status: !hasCSP ? "FAIL" : unsafeDirectives.length > 0 ? "WARN" : "PASS",
          detail: !hasCSP
            ? "No Content-Security-Policy found. Add a CSP meta tag in HTML, or set CSP headers via session.defaultSession.webRequest.onHeadersReceived in the main process."
            : unsafeDirectives.length > 0
              ? `CSP defined but contains ${unsafeDirectives.join(" and ")}. Tighten your CSP to remove ${unsafeDirectives.length > 1 ? "these directives" : "this directive"}.`
              : hasCspInSession && !hasCspInHtml
                ? "CSP is set via session.webRequest.onHeadersReceived in main code. The CSP value itself isn't statically inspected -- verify it manually."
                : "CSP is defined.",
        });
      }

      // 7. allowRunningInsecureContent
      if (bwConfig) {
        const insecure = /allowRunningInsecureContent\s*:\s*true/.test(bwConfig);
        checks.push({
          id: 7,
          name: "Do not enable allowRunningInsecureContent",
          status: insecure ? "FAIL" : "PASS",
          detail: insecure
            ? "allowRunningInsecureContent is enabled. This allows HTTPS pages to load scripts from HTTP -- a downgrade attack vector."
            : "allowRunningInsecureContent is not enabled.",
        });
      }

      // 8. experimentalFeatures
      if (bwConfig) {
        const exp = /experimentalFeatures\s*:\s*true/.test(bwConfig);
        checks.push({
          id: 8,
          name: "Do not enable experimental Chromium features",
          status: exp ? "WARN" : "PASS",
          detail: exp
            ? "experimentalFeatures is enabled. These features may have security bugs -- disable in production."
            : "Experimental features are not enabled.",
        });
      }

      // 9. enableBlinkFeatures
      if (bwConfig) {
        const blink = /enableBlinkFeatures/.test(bwConfig);
        checks.push({
          id: 9,
          name: "Do not use enableBlinkFeatures",
          status: blink ? "WARN" : "PASS",
          detail: blink
            ? "enableBlinkFeatures is set. Chromium disables certain features for good reason. Avoid enabling them."
            : "No extra Blink features enabled.",
        });
      }

      // 10. Preload security
      if (preload) {
        // Match ipcRenderer as a bare value (`{ ipcRenderer }`, `{ x: ipcRenderer }`)
        // or as a bare method reference (`{ send: ipcRenderer.send }`). The `[^}]*`
        // form of the previous regex broke on nested braces -- this bounded pattern
        // relies on a terminator character instead. Mirrors the regex in
        // electron_audit_ipc_security so both tools agree on what counts as raw
        // exposure.
        const rawExpose =
          /contextBridge\.exposeInMainWorld[\s\S]*?\bipcRenderer(?:\.(?:send|invoke|on|once|sendSync|postMessage|sendTo|sendToHost|removeListener|removeAllListeners))?\s*(?:[,}]|$)/.test(
            preload,
          );
        const directAssign = /(?:window|globalThis)\.\w+\s*=/.test(preload);
        const hasRemote = /require\s*\(\s*['"]@electron\/remote['"]\s*\)/.test(preload);

        if (rawExpose) {
          checks.push({
            id: 10,
            name: "Do not expose ipcRenderer directly",
            status: "FAIL",
            detail:
              "Raw ipcRenderer is exposed through contextBridge. Wrap each IPC call in a specific function that hardcodes the channel name.",
          });
        }
        if (directAssign) {
          checks.push({
            id: 11,
            name: "Use contextBridge, not direct window assignment",
            status: "FAIL",
            detail: "Direct window property assignment detected. Use contextBridge.exposeInMainWorld() instead.",
          });
        }
        if (hasRemote) {
          checks.push({
            id: 12,
            name: "Do not use @electron/remote",
            status: "WARN",
            detail:
              "@electron/remote crosses process boundaries unsafely and has known security issues. Migrate to explicit IPC patterns.",
          });
        }
      }

      // 13. Electron version check -- Electron supports the current stable +
      // previous two majors. Derive the window from the embedded knowledge
      // vintage instead of hardcoding so this stays accurate after a bump.
      if (pkgJson) {
        if (ver < SUPPORTED_MIN) {
          checks.push({
            id: 13,
            name: "Use a supported Electron version",
            status: "WARN",
            detail: `Electron ${ver} is detected. Only the latest 3 major versions are supported with security patches (currently v${SUPPORTED_MIN}-v${SUPPORTED_MAX}). Upgrade to receive security fixes.`,
          });
        } else {
          checks.push({
            id: 13,
            name: "Use a supported Electron version",
            status: "PASS",
            detail: `Electron ${ver} is within the supported range (v${SUPPORTED_MIN}-v${SUPPORTED_MAX}).`,
          });
        }
      }

      // 14. shell.openExternal validation (main process)
      if (mainCode && /shell\.openExternal\s*\(/.test(mainCode)) {
        const unsafe = unsafeOpenExternalCallSites(mainCode);
        checks.push({
          id: 14,
          name: "Validate URLs passed to shell.openExternal",
          status: unsafe.length === 0 ? "PASS" : "WARN",
          detail:
            unsafe.length === 0
              ? "All shell.openExternal call sites use a hardcoded https:// string literal."
              : `Found ${unsafe.length} shell.openExternal call(s) with non-literal or non-https arguments. shell.openExternal can invoke protocol handlers like file:// and smb:// -- validate the URL's protocol before opening untrusted input.`,
        });
      }

      // 15. file:// protocol usage
      if (mainCode && /['"`]file:\/\//.test(mainCode)) {
        checks.push({
          id: 15,
          name: "Avoid file:// for app content",
          status: "WARN",
          detail:
            "file:// URL detected in main code. The file:// protocol bypasses CORS and grants unusual privileges; prefer protocol.handle() with a custom scheme for loading app content.",
        });
      }

      // 16. <webview> tag
      if (html && /<webview\b/i.test(html)) {
        checks.push({
          id: 16,
          name: "Avoid the <webview> tag",
          status: "WARN",
          detail:
            "<webview> tag detected. The webview tag has known security issues and a complex security model -- prefer BrowserView / WebContentsView for embedding remote or untrusted content.",
        });
      }

      // 17 / 18 share a trigger: code that actually CONSTRUCTS a window.
      // Substring matching on `BrowserWindow` would also fire on string
      // literals or type-only references; require `new BrowserWindow(...)`
      // or `new BaseWindow(...)` so we only ask about navigation/open
      // restrictions when there's a concrete window to apply them to.
      const constructsWindow = /new\s+(?:BrowserWindow|BaseWindow)\s*\(/.test(mainCode);

      // 17. will-navigate handler restricting navigation
      if (constructsWindow) {
        const hasGuard = /will-navigate/.test(mainCode);
        checks.push({
          id: 17,
          name: "Restrict navigation with will-navigate",
          status: hasGuard ? "PASS" : "WARN",
          detail: hasGuard
            ? "will-navigate handler detected."
            : "No will-navigate handler. Without one, the renderer can navigate to arbitrary URLs that may exploit the parent's webPreferences.",
        });
      }

      // 18. setWindowOpenHandler restricting new windows
      if (constructsWindow) {
        const hasGuard = /setWindowOpenHandler/.test(mainCode);
        checks.push({
          id: 18,
          name: "Restrict new-window creation with setWindowOpenHandler",
          status: hasGuard ? "PASS" : "WARN",
          detail: hasGuard
            ? "setWindowOpenHandler detected."
            : "No setWindowOpenHandler. window.open() in the renderer creates new BrowserWindows that inherit the parent's webPreferences -- attach a handler to deny or sandbox them.",
        });
      }

      // 19. IPC sender validation
      // Look for actual origin reads (senderFrame.url/origin or sender.getURL()),
      // not just any mention of `event.sender` -- the latter matches
      // `event.sender.send(...)` which is the OPPOSITE of validation.
      if (mainCode && /ipcMain\.(handle|on)\s*\(/.test(mainCode)) {
        const hasGuard = /senderFrame\s*\.\s*(?:url|origin)|sender\s*\.\s*getURL\s*\(/.test(mainCode);
        checks.push({
          id: 19,
          name: "Validate IPC sender",
          status: hasGuard ? "PASS" : "WARN",
          detail: hasGuard
            ? "IPC handlers read event.senderFrame.url / .origin (or sender.getURL()) -- ensure security-sensitive handlers actually compare it against an allowlist, not just read it."
            : "No IPC sender validation detected. Any frame (including injected web content in a webview) can invoke ipcMain handlers; check event.senderFrame.url in security-sensitive ones.",
        });
      }

      if (checks.length === 0) {
        return "Please provide at least one of: browserWindowConfig, mainCode, packageJson, preloadCode, or htmlContent to audit.";
      }

      const passed = checks.filter((c) => c.status === "PASS").length;
      const failed = checks.filter((c) => c.status === "FAIL").length;
      const warned = checks.filter((c) => c.status === "WARN").length;

      let report = "# Electron Security Audit\n\n";
      report += `**Score: ${passed}/${checks.length} passed** | ${failed} failed | ${warned} warnings\n\n`;

      for (const c of checks) {
        const icon = c.status === "PASS" ? "[PASS]" : c.status === "FAIL" ? "[FAIL]" : "[WARN]";
        report += `## ${icon} #${c.id}: ${c.name}\n\n${c.detail}\n\n`;
      }

      if (failed > 0) {
        report += `---\n\n**Action required:** ${failed} check(s) failed. Address FAIL items before shipping to production.\n`;
      }

      report +=
        "\n---\n\n**Items not covered by static analysis:** session permission request handling and Electron fuse configuration require runtime / packaging context. Use `electron_configure_fuses` to generate a fuses config and review `session.setPermissionRequestHandler` in the official security tutorial.\n";

      return report;
    },
  },

  {
    name: "electron_configure_fuses",
    description:
      "Generate @electron/fuses configuration to harden your Electron app. Fuses are compile-time toggles that disable dangerous Electron features (like ELECTRON_RUN_AS_NODE, NODE_OPTIONS) and cannot be re-enabled by end users. Essential for production apps.",
    annotations: {
      title: "Configure Electron fuses",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      level: z
        .enum(["recommended", "strict", "custom"])
        .describe(
          "'recommended' for sensible defaults, 'strict' for maximum security, 'custom' to specify each fuse individually",
        ),
      customFuses: z
        .object({
          runAsNode: z.boolean().optional().describe("Allow ELECTRON_RUN_AS_NODE env var (default: disable)"),
          cookieEncryption: z.boolean().optional().describe("Encrypt cookies at rest (default: enable)"),
          nodeOptions: z.boolean().optional().describe("Allow NODE_OPTIONS env var (default: disable)"),
          nodeCliInspect: z.boolean().optional().describe("Allow --inspect CLI flag (default: disable)"),
          embeddedAsarIntegrity: z.boolean().optional().describe("Validate ASAR integrity (default: enable)"),
          onlyLoadAppFromAsar: z.boolean().optional().describe("Only load app from ASAR archive (default: enable)"),
          loadBrowserProcessSpecificV8Snapshot: z
            .boolean()
            .optional()
            .describe("Use browser-specific V8 snapshot (default: disable)"),
          grantFileProtocolExtraPrivileges: z
            .boolean()
            .optional()
            .describe("Grant file:// protocol extra privileges (default: disable)"),
        })
        .optional()
        .describe("Individual fuse settings (only for 'custom' level)"),
    }),
    handler: async (input: {
      level: string;
      customFuses?: {
        runAsNode?: boolean;
        cookieEncryption?: boolean;
        nodeOptions?: boolean;
        nodeCliInspect?: boolean;
        embeddedAsarIntegrity?: boolean;
        onlyLoadAppFromAsar?: boolean;
        loadBrowserProcessSpecificV8Snapshot?: boolean;
        grantFileProtocolExtraPrivileges?: boolean;
      };
    }) => {
      interface FuseConfig {
        runAsNode: boolean;
        cookieEncryption: boolean;
        nodeOptions: boolean;
        nodeCliInspect: boolean;
        embeddedAsarIntegrity: boolean;
        onlyLoadAppFromAsar: boolean;
        loadBrowserProcessSpecificV8Snapshot: boolean;
        grantFileProtocolExtraPrivileges: boolean;
      }

      let fuses: FuseConfig;

      if (input.level === "strict") {
        fuses = {
          runAsNode: false,
          cookieEncryption: true,
          nodeOptions: false,
          nodeCliInspect: false,
          embeddedAsarIntegrity: true,
          onlyLoadAppFromAsar: true,
          loadBrowserProcessSpecificV8Snapshot: false,
          grantFileProtocolExtraPrivileges: false,
        };
      } else if (input.level === "custom" && input.customFuses) {
        fuses = {
          runAsNode: input.customFuses.runAsNode ?? false,
          cookieEncryption: input.customFuses.cookieEncryption ?? true,
          nodeOptions: input.customFuses.nodeOptions ?? false,
          nodeCliInspect: input.customFuses.nodeCliInspect ?? false,
          embeddedAsarIntegrity: input.customFuses.embeddedAsarIntegrity ?? true,
          onlyLoadAppFromAsar: input.customFuses.onlyLoadAppFromAsar ?? true,
          loadBrowserProcessSpecificV8Snapshot: input.customFuses.loadBrowserProcessSpecificV8Snapshot ?? false,
          grantFileProtocolExtraPrivileges: input.customFuses.grantFileProtocolExtraPrivileges ?? false,
        };
      } else {
        // recommended
        fuses = {
          runAsNode: false,
          cookieEncryption: true,
          nodeOptions: false,
          nodeCliInspect: false,
          embeddedAsarIntegrity: true,
          onlyLoadAppFromAsar: true,
          loadBrowserProcessSpecificV8Snapshot: false,
          grantFileProtocolExtraPrivileges: false,
        };
      }

      const code = `// forge.config.ts (Electron Forge)
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

export default {
  // ... other forge config
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: ${fuses.runAsNode},
      [FuseV1Options.EnableCookieEncryption]: ${fuses.cookieEncryption},
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: ${fuses.nodeOptions},
      [FuseV1Options.EnableNodeCliInspectArguments]: ${fuses.nodeCliInspect},
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ${fuses.embeddedAsarIntegrity},
      [FuseV1Options.OnlyLoadAppFromAsar]: ${fuses.onlyLoadAppFromAsar},
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: ${fuses.loadBrowserProcessSpecificV8Snapshot},
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: ${fuses.grantFileProtocolExtraPrivileges},
    }),
  ],
};`;

      const standalone = `// Standalone usage (without Electron Forge)
// Run after packaging: npx @electron/fuses read --app /path/to/your/app
// Or programmatically:

import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

await flipFuses(
  "/path/to/packaged/app",
  {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: ${fuses.runAsNode},
    [FuseV1Options.EnableCookieEncryption]: ${fuses.cookieEncryption},
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: ${fuses.nodeOptions},
    [FuseV1Options.EnableNodeCliInspectArguments]: ${fuses.nodeCliInspect},
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ${fuses.embeddedAsarIntegrity},
    [FuseV1Options.OnlyLoadAppFromAsar]: ${fuses.onlyLoadAppFromAsar},
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: ${fuses.loadBrowserProcessSpecificV8Snapshot},
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: ${fuses.grantFileProtocolExtraPrivileges},
  }
);`;

      const explanations = [
        "| Fuse | Value | Effect |",
        "|------|-------|--------|",
        `| RunAsNode | ${fuses.runAsNode} | ${fuses.runAsNode ? "ELECTRON_RUN_AS_NODE env var is allowed -- app can be used as a Node.js runtime" : "Blocks ELECTRON_RUN_AS_NODE -- prevents hijacking your app binary as a Node.js runtime"} |`,
        `| CookieEncryption | ${fuses.cookieEncryption} | ${fuses.cookieEncryption ? "Cookies encrypted at rest using OS keychain" : "Cookies stored in plaintext"} |`,
        `| NodeOptions | ${fuses.nodeOptions} | ${fuses.nodeOptions ? "NODE_OPTIONS env var is allowed -- could inject code via --require" : "Blocks NODE_OPTIONS -- prevents code injection via environment"} |`,
        `| NodeCliInspect | ${fuses.nodeCliInspect} | ${fuses.nodeCliInspect ? "--inspect flag is allowed -- enables remote debugging" : "Blocks --inspect -- prevents remote debugging in production"} |`,
        `| EmbeddedAsarIntegrity | ${fuses.embeddedAsarIntegrity} | ${fuses.embeddedAsarIntegrity ? "ASAR archive integrity is validated at runtime" : "No ASAR integrity validation"} |`,
        `| OnlyLoadAppFromAsar | ${fuses.onlyLoadAppFromAsar} | ${fuses.onlyLoadAppFromAsar ? "App can only be loaded from ASAR -- prevents side-loading code" : "App can be loaded from loose files"} |`,
        `| LoadBrowserProcessSpecificV8Snapshot | ${fuses.loadBrowserProcessSpecificV8Snapshot} | ${fuses.loadBrowserProcessSpecificV8Snapshot ? "Uses browser-specific V8 snapshot" : "Uses standard V8 snapshot"} |`,
        `| GrantFileProtocolExtraPrivileges | ${fuses.grantFileProtocolExtraPrivileges} | ${fuses.grantFileProtocolExtraPrivileges ? "file:// protocol has extra privileges (fetch, service workers, etc.)" : "file:// protocol has restricted privileges -- more secure"} |`,
      ];

      const install = `## Installation

\`\`\`bash
# With Electron Forge
npm install --save-dev @electron-forge/plugin-fuses @electron/fuses

# Standalone
npm install --save-dev @electron/fuses
\`\`\``;

      return `# Electron Fuses Configuration (${input.level})\n\n${explanations.join("\n")}\n\n${install}\n\n## Electron Forge Integration\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n## Standalone Usage\n\n\`\`\`typescript\n${standalone}\n\`\`\`\n\n## Important Notes\n\n- Fuses are flipped at **package time**, not runtime. They modify the Electron binary itself.\n- Once a fuse is flipped, end users cannot change it back.\n- Always test your packaged app after flipping fuses -- some functionality may break if your app depends on disabled features.\n- Use \`npx @electron/fuses read --app /path/to/app\` to verify fuse state in a packaged build.`;
    },
  },

  {
    name: "electron_configure_csp",
    description:
      "Generate a Content Security Policy for an Electron app. Accounts for the bundler (Vite, webpack), framework (React, Vue, Svelte), and whether dev-mode exceptions are needed. Returns both meta-tag and session.webRequest approaches.",
    annotations: {
      title: "Configure Content Security Policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      bundler: z
        .enum(["vite", "webpack", "none"])
        .optional()
        .describe("Bundler used (affects script-src for HMR in dev mode). Defaults to 'vite'."),
      framework: z
        .enum(["react", "vue", "svelte", "vanilla"])
        .optional()
        .describe("Frontend framework. Defaults to 'react'."),
      needsInlineStyles: z
        .boolean()
        .optional()
        .describe("Whether inline styles are required (e.g. CSS-in-JS). Defaults to false."),
      needsEval: z
        .boolean()
        .optional()
        .describe("Whether eval() is needed (some template compilers). Defaults to false."),
      externalConnections: z
        .array(z.string())
        .optional()
        .describe("External origins the app connects to, e.g. ['https://api.example.com', 'wss://ws.example.com']"),
      externalImages: z
        .array(z.string())
        .optional()
        .describe("External origins for images, e.g. ['https://cdn.example.com']"),
    }),
    handler: async (input: {
      bundler?: string;
      framework?: string;
      needsInlineStyles?: boolean;
      needsEval?: boolean;
      externalConnections?: string[];
      externalImages?: string[];
    }) => {
      const bundler = input.bundler || "vite";
      const connectSrc = ["'self'", ...(input.externalConnections || [])];
      const imgSrc = ["'self'", "data:", ...(input.externalImages || [])];

      // Production CSP
      let scriptSrc = "'self'";
      let styleSrc = "'self'";

      if (input.needsEval) {
        scriptSrc += " 'unsafe-eval'";
      }
      if (input.needsInlineStyles) {
        styleSrc += " 'unsafe-inline'";
      }

      const prodCSP = [
        `default-src 'self'`,
        `script-src ${scriptSrc}`,
        `style-src ${styleSrc}`,
        `img-src ${imgSrc.join(" ")}`,
        `font-src 'self' data:`,
        `connect-src ${connectSrc.join(" ")}`,
        `media-src 'self'`,
        `object-src 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`,
        `frame-ancestors 'none'`,
      ].join("; ");

      // Dev CSP (more permissive for HMR)
      const devConnectSrc = [...connectSrc];
      let devScriptSrc = scriptSrc;

      if (bundler === "vite") {
        devConnectSrc.push("ws://localhost:*");
        devScriptSrc += " 'unsafe-inline'"; // Vite HMR needs inline scripts
      } else if (bundler === "webpack") {
        devConnectSrc.push("ws://localhost:*");
        devScriptSrc += " 'unsafe-eval'"; // webpack HMR uses eval
      }

      // style-src in dev: HMR-injected style tags require 'unsafe-inline' for
      // Vite and webpack. If the user explicitly opted out (needsInlineStyles
      // === false) AND isn't using one of those bundlers, honor the opt-out.
      // For Vite/webpack we still emit unsafe-inline because dev styling
      // breaks without it -- the dev CSP is loaded only against your own
      // dev server, so this is a controlled relaxation.
      const bundlerNeedsInlineStyles = bundler === "vite" || bundler === "webpack";
      const devStyleNeedsInline = input.needsInlineStyles !== false || bundlerNeedsInlineStyles;
      const devStyleSrc =
        devStyleNeedsInline && !styleSrc.includes("'unsafe-inline'") ? `${styleSrc} 'unsafe-inline'` : styleSrc;

      const devCSP = [
        `default-src 'self'`,
        `script-src ${devScriptSrc}`,
        `style-src ${devStyleSrc}`,
        `img-src ${imgSrc.join(" ")}`,
        `font-src 'self' data:`,
        `connect-src ${devConnectSrc.join(" ")}`,
        `media-src 'self'`,
        `object-src 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`,
        `frame-ancestors 'none'`,
      ].join("; ");

      const metaTag = `<!-- index.html -->
<meta http-equiv="Content-Security-Policy" content="${prodCSP}">`;

      const sessionCode = `// main process -- set CSP via session headers (recommended)
import { session } from "electron";

const isDev = !app.isPackaged;

const CSP = isDev
  ? "${devCSP}"
  : "${prodCSP}";

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });
});`;

      const sections = [
        "# Content Security Policy for Electron\n",
        `## Option 1: Meta Tag (simple)\n\n\`\`\`html\n${metaTag}\n\`\`\``,
        `## Option 2: Session Headers (recommended)\n\n\`\`\`typescript\n${sessionCode}\n\`\`\`\n\nThe session approach is preferred because:\n- It applies to all navigations and subframes\n- It can differentiate between dev and production\n- It can't be removed by modifying HTML`,
        `## Production CSP\n\n\`\`\`\n${prodCSP}\n\`\`\``,
        `## Development CSP\n\n\`\`\`\n${devCSP}\n\`\`\`\n\n${bundler === "vite" ? "Dev CSP allows inline scripts for Vite HMR and WebSocket connections for hot reload." : bundler === "webpack" ? "Dev CSP allows unsafe-eval for webpack HMR and WebSocket connections for hot reload." : ""}`,
      ];

      if (input.needsEval) {
        sections.push(
          `## Warning: unsafe-eval\n\nYour CSP includes \`'unsafe-eval'\`. This weakens XSS protection. Common reasons:\n- Vue template compiler (use pre-compiled templates instead)\n- Legacy eval-based code (refactor to alternatives)\n\nConsider removing this if possible.`,
        );
      }

      return sections.join("\n\n");
    },
  },

  {
    name: "electron_lint_security",
    description:
      "Static analysis of Electron code for dangerous patterns: shell.openExternal with user input, @electron/remote usage, disabled webSecurity, missing navigation restrictions, unrestricted window creation, and other OWASP-style vulnerabilities specific to Electron.",
    annotations: {
      title: "Lint for security issues",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      code: z.string().max(500_000).describe("Source code to analyze (main process, preload, or renderer)"),
      fileType: z
        .enum(["main", "preload", "renderer"])
        .optional()
        .describe("Which process this code runs in. Helps scope the analysis. Defaults to 'main'."),
    }),
    handler: async (input: { code: string; fileType?: string }) => {
      const fileType = input.fileType || "main";
      // Strip comments so docstrings/inline notes don't fire findings, and
      // strip string literals for the eval / innerHTML checks since `"use
      // eval()"` is documentation, not a call. Other checks below scan the
      // comment-stripped (but string-preserving) version where the pattern
      // requires a string literal (module name, channel name, etc.).
      const code = stripComments(input.code);
      const codeNoStrings = stripCommentsAndStrings(input.code);
      const findings: Array<{ severity: string; pattern: string; detail: string; fix: string; line?: string }> = [];

      // Universal checks -- run against the no-strings version so a comment
      // or string literal that mentions `eval()` doesn't generate a finding.
      if (/\beval\s*\(/.test(codeNoStrings)) {
        findings.push({
          severity: "HIGH",
          pattern: "eval() usage",
          detail:
            "eval() executes arbitrary code. If the input is user-controlled, this is a code injection vulnerability.",
          fix: "Replace eval() with JSON.parse() for data, or Function() for computed code (if absolutely necessary).",
        });
      }

      if (/\.innerHTML\s*=/.test(codeNoStrings) || /dangerouslySetInnerHTML/.test(codeNoStrings)) {
        findings.push({
          severity: "HIGH",
          pattern: "innerHTML / dangerouslySetInnerHTML",
          detail:
            "Setting innerHTML with user-controlled data enables XSS attacks in Electron, which can be more severe than in browsers due to Node.js access.",
          fix: "Use textContent for text, or sanitize HTML with DOMPurify before insertion.",
        });
      }

      if (fileType === "main") {
        // shell.openExternal: examine call sites individually so
        // hardcoded https-literal calls don't produce a finding, and so
        // unrelated `startsWith('https')` elsewhere in the file doesn't
        // mask a genuinely unvalidated call.
        if (unsafeOpenExternalCallSites(code).length > 0) {
          findings.push({
            severity: "HIGH",
            pattern: "shell.openExternal without URL validation",
            detail:
              "shell.openExternal can execute arbitrary commands via protocol handlers (file://, smb://, etc.). If the URL is derived from user input or renderer messages, it must be validated.",
            fix: `Validate protocol before opening:\n\`\`\`typescript\nconst url = new URL(untrustedInput);\nif (url.protocol === "https:" || url.protocol === "http:") {\n  shell.openExternal(url.toString());\n}\n\`\`\``,
          });
        }

        // Missing will-navigate handler
        if (/BrowserWindow|new\s+BaseWindow/.test(code) && !/will-navigate/.test(code)) {
          findings.push({
            severity: "MEDIUM",
            pattern: "No will-navigate handler",
            detail:
              "Without a will-navigate handler, the BrowserWindow can be navigated to any URL, including external sites that could exploit nodeIntegration or other permissions.",
            fix: `Add a will-navigate handler to restrict navigation:\n\`\`\`typescript\nwin.webContents.on("will-navigate", (event, url) => {\n  const parsedUrl = new URL(url);\n  if (parsedUrl.origin !== "https://your-app.com") {\n    event.preventDefault();\n  }\n});\n\`\`\``,
          });
        }

        // Missing setWindowOpenHandler
        if (/BrowserWindow|new\s+BaseWindow/.test(code) && !/setWindowOpenHandler/.test(code)) {
          findings.push({
            severity: "MEDIUM",
            pattern: "No setWindowOpenHandler",
            detail:
              "Without setWindowOpenHandler, window.open() in the renderer creates new windows with the parent's webPreferences, potentially including elevated permissions.",
            fix: `Add setWindowOpenHandler to control new window creation:\n\`\`\`typescript\nwin.webContents.setWindowOpenHandler(({ url }) => {\n  // Open external URLs in the system browser\n  if (url.startsWith("https://")) {\n    shell.openExternal(url);\n  }\n  return { action: "deny" };\n});\n\`\`\``,
          });
        }

        // @electron/remote
        if (/@electron\/remote/.test(code)) {
          findings.push({
            severity: "MEDIUM",
            pattern: "@electron/remote usage",
            detail:
              "@electron/remote proxies main process objects to the renderer, crossing the security boundary. It has known issues with prototype pollution and garbage collection.",
            fix: "Migrate to explicit IPC: use ipcMain.handle() + ipcRenderer.invoke() through a preload bridge.",
          });
        }
      }

      if (fileType === "renderer") {
        // Direct require('electron')
        if (/require\s*\(\s*['"]electron['"]\s*\)/.test(code) || /from\s+['"]electron['"]/.test(code)) {
          findings.push({
            severity: "CRITICAL",
            pattern: "Direct electron import in renderer",
            detail:
              "Importing electron directly in the renderer requires nodeIntegration (a security risk). Use the preload bridge instead.",
            fix: "Access Electron features through window.electronAPI (exposed by the preload script).",
          });
        }

        // require('child_process'), require('fs'), etc.
        if (/require\s*\(\s*['"](?:child_process|fs|os|path|crypto|net|http|https)['"]\s*\)/.test(code)) {
          findings.push({
            severity: "CRITICAL",
            pattern: "Node.js module import in renderer",
            detail:
              "Importing Node.js modules in the renderer requires nodeIntegration. These operations should be handled in the main process and accessed via IPC.",
            fix: "Move this logic to the main process and expose it through a preload bridge.",
          });
        }
      }

      if (fileType === "preload") {
        // Full module exposure
        if (/contextBridge\.exposeInMainWorld\s*\([^,]+,\s*require\s*\(/.test(code)) {
          findings.push({
            severity: "CRITICAL",
            pattern: "Entire module exposed through contextBridge",
            detail:
              "Exposing a full module (like electron) through contextBridge gives the renderer unrestricted access to that module's API surface.",
            fix: "Expose only specific, wrapped functions that hardcode the channel name and validate arguments.",
          });
        }
      }

      // For preload code, this lint checks only one pattern (full-module
      // exposure via contextBridge). The richer preload checks --
      // raw ipcRenderer exposure, missing sender validation, listener leaks,
      // direct window.* assignment -- live in `electron_audit_ipc_security`.
      // Surface that pointer in every preload report so a CLEAN here is not
      // mistaken for a comprehensive bill of health.
      const preloadFooter =
        fileType === "preload"
          ? "\n\n---\n\n**Preload coverage note:** this lint only checks for full-module exposure via `contextBridge`. For comprehensive preload analysis (raw `ipcRenderer` exposure, missing sender validation, listener leaks, direct `window.*` assignment), run `electron_audit_ipc_security` with the same preload code."
          : "";

      if (findings.length === 0) {
        return `# Security Lint: CLEAN\n\nNo security issues detected in ${fileType} process code.\n\nNote: This is a static pattern analysis. It cannot detect all security issues -- always review the full application context and follow Electron's security checklist.${preloadFooter}`;
      }

      const sorted = findings.sort((a, b) => {
        const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
      });

      let report = `# Security Lint: ${sorted[0].severity === "CRITICAL" ? "CRITICAL ISSUES" : "ISSUES FOUND"}\n\n`;
      report += `Found ${findings.length} issue(s) in ${fileType} process code.\n\n`;

      for (const [i, f] of sorted.entries()) {
        report += `## ${i + 1}. [${f.severity}] ${f.pattern}\n\n${f.detail}\n\n### Fix\n\n${f.fix}\n\n`;
      }

      return report + preloadFooter;
    },
  },
] as const;
