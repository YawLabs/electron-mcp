import assert from "node:assert";
import { describe, it } from "node:test";
import { buildTools } from "./build.js";
import { ipcTools } from "./ipc.js";
import { knowledgeTools } from "./knowledge.js";
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
  ...knowledgeTools,
];

type Handler = (input: unknown) => Promise<string>;
const byName = (name: string): Handler => {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler as Handler;
};

describe("tool registration", () => {
  it("exports 18 tools", () => {
    assert.strictEqual(allTools.length, 18);
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
  const tool = byName("electron_scaffold_ipc_channel");

  it("generates IPC boilerplate for renderer-to-main invoke", async () => {
    const result = await tool({
      channelName: "get-user",
      direction: "renderer-to-main",
      description: "Fetches user data",
      args: "{ userId: string }",
      returnType: "{ name: string }",
    });
    assert.ok(result.includes("ipcMain.handle"));
    assert.ok(result.includes("ipcRenderer.invoke"));
    assert.ok(result.includes("contextBridge"));
    assert.ok(result.includes("get-user"));
    assert.ok(result.includes("getUser"));
  });

  it("main-to-renderer uses webContents.send pattern", async () => {
    const result = await tool({
      channelName: "progress-update",
      direction: "main-to-renderer",
      description: "Streams progress to the renderer",
      args: "{ percent: number }",
    });
    assert.ok(result.includes("progress-update"));
    assert.ok(result.includes("ipcRenderer.on"));
    assert.ok(result.includes("removeListener"), "main-to-renderer must provide cleanup");
  });
});

describe("electron_generate_preload_bridge", () => {
  const tool = byName("electron_generate_preload_bridge");

  it("emits contextBridge + type declarations for multiple methods", async () => {
    const result = await tool({
      methods: [
        { name: "openFile", channel: "open-file", type: "invoke", returnType: "string" },
        { name: "onProgress", channel: "progress", type: "on", args: "{ pct: number }" },
      ],
      namespace: "myAPI",
    });
    assert.ok(result.includes("contextBridge.exposeInMainWorld"));
    assert.ok(result.includes("myAPI"));
    assert.ok(result.includes("openFile"));
    assert.ok(result.includes("ipcRenderer.invoke"));
    assert.ok(result.includes("onProgress"));
    assert.ok(result.includes("removeListener"), "on-type methods must emit cleanup");
    assert.ok(result.includes("interface MyAPI"), "must emit the typed namespace interface");
  });
});

describe("electron_audit_ipc_security", () => {
  const tool = byName("electron_audit_ipc_security");

  it("flags raw ipcRenderer exposure as CRITICAL", async () => {
    const result = await tool({
      preloadCode: `contextBridge.exposeInMainWorld('api', { ipcRenderer })`,
    });
    assert.ok(result.includes("CRITICAL"));
    assert.ok(result.includes("ipcRenderer"));
  });

  it("flags sendSync as a warning", async () => {
    const result = await tool({
      preloadCode: `const x = ipcRenderer.sendSync('channel')`,
    });
    assert.ok(result.includes("sendSync"));
    assert.ok(result.includes("WARNING"));
  });

  it("passes clean contextBridge usage", async () => {
    const result = await tool({
      preloadCode: `contextBridge.exposeInMainWorld('api', {
        getData: () => ipcRenderer.invoke('get-data'),
        onUpdate: (cb) => {
          const handler = (_e, d) => cb(d);
          ipcRenderer.on('update', handler);
          return () => ipcRenderer.removeListener('update', handler);
        }
      });`,
    });
    assert.ok(result.includes("PASSED") || result.includes("No security issues"));
  });
});

describe("electron_generate_window_manager", () => {
  const tool = byName("electron_generate_window_manager");

  it("emits a WindowManager class with configs for each window", async () => {
    const result = await tool({
      windows: [
        { id: "main", title: "Main", width: 1200, height: 800 },
        { id: "settings", title: "Settings", type: "modal" },
      ],
    });
    assert.ok(result.includes("class WindowManager"));
    assert.ok(result.includes('"main"'));
    assert.ok(result.includes('"settings"'));
    assert.ok(result.includes("modal: true"), "modal windows must set modal: true");
    assert.ok(result.includes("saveWindowState"), "persistState defaults to true");
  });

  it("omits persistence code when persistState is false", async () => {
    const result = await tool({
      windows: [{ id: "main", title: "Main" }],
      persistState: false,
    });
    assert.ok(result.includes("class WindowManager"));
    assert.ok(!result.includes("saveWindowState"));
  });
});

describe("electron_explain_process_model", () => {
  const tool = byName("electron_explain_process_model");

  it("returns substantial content for every topic", async () => {
    const topics = [
      "overview",
      "main-process",
      "renderer-process",
      "preload-scripts",
      "context-isolation",
      "sandbox",
      "utility-process",
      "ipc-patterns",
    ];
    for (const topic of topics) {
      const result = await tool({ topic });
      assert.ok(result.length > 200, `${topic} explanation too short (got ${result.length} chars)`);
    }
  });
});

describe("electron_audit_security", () => {
  const tool = byName("electron_audit_security");

  it("detects nodeIntegration: true", async () => {
    const result = await tool({
      browserWindowConfig: "{ webPreferences: { nodeIntegration: true } }",
    });
    assert.ok(result.includes("FAIL"));
    assert.ok(result.includes("nodeIntegration"));
  });

  it("passes clean config", async () => {
    const result = await tool({
      browserWindowConfig: "{ webPreferences: { contextIsolation: true, sandbox: true } }",
    });
    assert.ok(result.includes("PASS"));
  });
});

describe("electron_configure_fuses", () => {
  const tool = byName("electron_configure_fuses");

  it("recommended level disables RunAsNode by default", async () => {
    const result = await tool({ level: "recommended" });
    assert.ok(result.includes("@electron/fuses"));
    assert.ok(result.includes("RunAsNode]: false"));
    assert.ok(result.includes("EnableCookieEncryption]: true"));
  });

  it("custom level respects explicit overrides", async () => {
    const result = await tool({
      level: "custom",
      customFuses: { runAsNode: true, cookieEncryption: false },
    });
    assert.ok(result.includes("RunAsNode]: true"));
    assert.ok(result.includes("EnableCookieEncryption]: false"));
  });
});

describe("electron_configure_csp", () => {
  const tool = byName("electron_configure_csp");

  it("generates default CSP without unsafe directives", async () => {
    const result = await tool({});
    assert.ok(result.includes("Content-Security-Policy") || result.includes("content-security-policy"));
    assert.ok(result.includes("default-src 'self'"));
    assert.ok(result.includes("frame-ancestors 'none'"));
  });

  it("adds unsafe-eval warning when requested", async () => {
    const result = await tool({ needsEval: true });
    assert.ok(result.includes("unsafe-eval"));
    assert.ok(result.includes("Warning") || result.includes("XSS"));
  });

  it("vite dev CSP permits localhost websockets", async () => {
    const result = await tool({ bundler: "vite" });
    assert.ok(result.includes("ws://localhost"));
  });

  it("includes external connections in connect-src", async () => {
    const result = await tool({
      externalConnections: ["https://api.example.com"],
    });
    assert.ok(result.includes("https://api.example.com"));
  });
});

describe("electron_lint_security", () => {
  const tool = byName("electron_lint_security");

  it("flags eval() in main process as HIGH", async () => {
    const result = await tool({
      code: "function run(input) { return eval(input); }",
      fileType: "main",
    });
    assert.ok(result.includes("HIGH"));
    assert.ok(result.includes("eval()"));
  });

  it("flags direct electron import in renderer as CRITICAL", async () => {
    const result = await tool({
      code: "import { ipcRenderer } from 'electron';",
      fileType: "renderer",
    });
    assert.ok(result.includes("CRITICAL"));
  });

  it("returns CLEAN for safe code", async () => {
    const result = await tool({
      code: "function add(a, b) { return a + b; }",
      fileType: "main",
    });
    assert.ok(result.includes("CLEAN") || result.includes("No security issues"));
  });
});

describe("electron_diagnose_build_error", () => {
  const tool = byName("electron_diagnose_build_error");

  it("identifies macOS code signing identity errors", async () => {
    const result = await tool({
      errorOutput: "Error: Code signing failed — no signing identity found for Developer ID Application",
      buildTool: "electron-builder",
      platform: "darwin",
    });
    assert.ok(result.includes("code signing") || result.includes("signing identity"));
    assert.ok(result.includes("security find-identity") || result.includes("identity"));
  });

  it("falls back to generic troubleshooting for unrecognized errors", async () => {
    const result = await tool({
      errorOutput: "Something completely unexpected happened during build",
    });
    assert.ok(result.includes("Unrecognized") || result.includes("troubleshooting"));
  });
});

describe("electron_configure_auto_update", () => {
  const tool = byName("electron_configure_auto_update");

  it("github provider embeds owner and repo", async () => {
    const result = await tool({
      provider: "github",
      githubOwner: "yawlabs",
      githubRepo: "my-app",
    });
    assert.ok(result.includes("electron-updater"));
    assert.ok(result.includes("yawlabs"));
    assert.ok(result.includes("my-app"));
    assert.ok(result.includes('"provider": "github"'));
  });

  it("manual download mode exposes update-download IPC", async () => {
    const result = await tool({
      provider: "github",
      autoDownload: false,
    });
    assert.ok(result.includes("autoDownload = false"));
    assert.ok(result.includes("update-download"));
  });

  it("s3 provider embeds bucket", async () => {
    const result = await tool({
      provider: "s3",
      s3Bucket: "my-releases",
    });
    assert.ok(result.includes("my-releases"));
    assert.ok(result.includes('"provider": "s3"'));
  });
});

describe("electron_configure_deep_linking", () => {
  const tool = byName("electron_configure_deep_linking");

  it("registers the given protocol across platforms", async () => {
    const result = await tool({ protocol: "myapp" });
    assert.ok(result.includes("myapp"));
    assert.ok(result.includes("setAsDefaultProtocolClient"));
    assert.ok(result.includes("open-url"), "macOS open-url handler must be emitted");
    assert.ok(result.includes("CFBundleURLSchemes"), "Info.plist config must be emitted");
  });

  it("emits route-specific handling when routes are provided", async () => {
    const result = await tool({
      protocol: "myapp",
      routes: [
        { path: "/settings", description: "Open settings" },
        { path: "/file/*", description: "Open a file" },
      ],
    });
    assert.ok(result.includes("/settings"));
    assert.ok(result.includes("Open settings"));
  });
});

describe("electron_scaffold_project", () => {
  const tool = byName("electron_scaffold_project");

  it("default scaffold uses electron-vite + react", async () => {
    const result = await tool({ name: "my-app" });
    assert.ok(result.includes("my-app"));
    assert.ok(result.includes("electron-vite") || result.includes("@quick-start/electron"));
    assert.ok(result.includes("contextIsolation: true"));
    assert.ok(result.includes("sandbox: true"));
  });

  it("tray feature adds tray code to main process", async () => {
    const result = await tool({
      name: "tray-app",
      features: ["tray"],
    });
    assert.ok(result.includes("Tray"));
    assert.ok(result.includes("Menu.buildFromTemplate"));
  });

  it("electron-forge buildTool suggests init electron-app", async () => {
    const result = await tool({
      name: "forge-app",
      buildTool: "electron-forge",
    });
    assert.ok(result.includes("electron-app"));
  });
});

describe("electron_migrate_version", () => {
  const tool = byName("electron_migrate_version");

  it("lists breaking changes for 28 to 41", async () => {
    const result = await tool({ currentVersion: 28, targetVersion: 41 });
    assert.ok(result.includes("Migration"));
    assert.ok(result.includes("Breaking Changes"));
    assert.ok(result.includes("Summary"));
  });

  it("rejects invalid ranges where target <= current", async () => {
    const result = await tool({ currentVersion: 30, targetVersion: 28 });
    assert.ok(result.includes("higher"));
  });

  it("surfaces macOS platform drops when crossing v33", async () => {
    const result = await tool({ currentVersion: 30, targetVersion: 35 });
    assert.ok(result.includes("macOS"));
    assert.ok(result.includes("Catalina") || result.includes("10.15"));
  });
});

describe("electron_check_deprecated_apis", () => {
  const tool = byName("electron_check_deprecated_apis");

  it("detects BrowserView usage and reports removal status", async () => {
    const result = await tool({
      code: "const view = new BrowserView({ webPreferences: {} });",
      electronVersion: 41,
    });
    assert.ok(result.includes("BrowserView"));
    assert.ok(result.includes("WebContentsView"));
  });

  it("flags ipcRenderer.sendTo as REMOVED at v29+", async () => {
    const result = await tool({
      code: `ipcRenderer.sendTo(webContentsId, 'channel', data);`,
      electronVersion: 41,
    });
    assert.ok(result.includes("REMOVED"));
    assert.ok(result.includes("MessagePort") || result.includes("MessageChannel"));
  });

  it("returns CLEAN for modern code", async () => {
    const result = await tool({
      code: `const result = await ipcRenderer.invoke('get-data');`,
    });
    assert.ok(result.includes("CLEAN"));
  });
});

describe("electron_audit_performance", () => {
  const tool = byName("electron_audit_performance");

  it("flags eager top-level import of heavy modules", async () => {
    const result = await tool({
      mainCode: `import sharp from "sharp";\napp.whenReady().then(() => {});`,
    });
    assert.ok(result.includes("sharp"));
    assert.ok(result.includes("Eager") || result.includes("lazy"));
  });

  it("flags synchronous fs in main process", async () => {
    const result = await tool({
      mainCode: `const data = fs.readFileSync("./config.json", "utf-8");`,
    });
    assert.ok(result.includes("Synchronous") || result.includes("sync"));
  });

  it("flags polyfills in renderer", async () => {
    const result = await tool({
      rendererCode: `import "core-js/stable";`,
    });
    assert.ok(result.includes("core-js"));
    assert.ok(result.includes("polyfill") || result.includes("Polyfill"));
  });

  it("returns CLEAN for well-optimized code", async () => {
    const result = await tool({
      mainCode: "app.whenReady().then(() => { createWindow(); });",
    });
    assert.ok(result.includes("CLEAN"));
  });

  it("prompts for input when nothing is provided", async () => {
    const result = await tool({});
    assert.ok(result.includes("Please provide") || result.includes("at least one"));
  });
});

describe("electron_explain_concept", () => {
  const tool = byName("electron_explain_concept");

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
      const result = await tool({ concept });
      assert.ok(result.length > 100, `${concept} explanation too short`);
    }
  });
});

describe("electron_knowledge_version", () => {
  const tool = byName("electron_knowledge_version");

  it("returns the embedded knowledge metadata", async () => {
    const result = await tool({});
    assert.ok(result.includes("Last verified"));
    assert.ok(result.includes("2026-04-13"), "lastVerified must match KNOWLEDGE_VERSION");
    assert.ok(result.includes("v41"), "electronStable must match");
    assert.ok(result.includes("electronjs.org"), "must include official source URL");
  });
});
