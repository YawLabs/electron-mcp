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
const schemaOf = (name: string) => {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.inputSchema;
};

// Derive the expected tool count from the per-category arrays so adding a
// tool only requires updating one place. Hard-coded counts drift silently.
const EXPECTED_TOOL_COUNT =
  ipcTools.length +
  securityTools.length +
  buildTools.length +
  migrationTools.length +
  performanceTools.length +
  referenceTools.length +
  knowledgeTools.length;

describe("tool registration", () => {
  it("allTools contains every per-category tool (no duplicates, no drops)", () => {
    assert.strictEqual(allTools.length, EXPECTED_TOOL_COUNT);
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

  it("main-to-renderer preload emits syntactically valid object (no leading comma)", async () => {
    // Regression: previously the template inserted `,\n    on...` unconditionally,
    // which produced a leading comma when there was no invoke/send method before it.
    const result = await tool({
      channelName: "progress-update",
      direction: "main-to-renderer",
      description: "Streams progress",
      args: "{ percent: number }",
    });
    // Extract the preload code block and verify it parses as valid JS.
    const match = result.match(/## Preload Script\n\n```typescript\n([\s\S]*?)\n```/);
    assert.ok(match, "preload code block must be present");
    const preload = match[1];
    assert.ok(!/\{\s*\/\/[^\n]*\n\s*,/.test(preload), `preload has a leading comma in the object literal:\n${preload}`);
    // The exposed object should open with a comment then the on* method -- not a stray comma.
    assert.ok(
      /\{\s*\/\/[^\n]*\n\s*onProgressUpdate:/.test(preload),
      "on* method must follow the description comment directly",
    );
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

  it("flags sendSync at LOW severity", async () => {
    const result = await tool({
      preloadCode: `const x = ipcRenderer.sendSync('channel')`,
    });
    assert.ok(result.includes("sendSync"));
    // Severity taxonomy was unified to CRITICAL | HIGH | MEDIUM | LOW across
    // every audit tool. sendSync and listener-without-cleanup are LOW.
    assert.ok(result.includes("LOW"), `expected LOW severity, got:\n${result}`);
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

  it("flags ipcRenderer method-reference exposure as CRITICAL", async () => {
    // Regression: the previous regex only matched bare `ipcRenderer` values.
    // `{ send: ipcRenderer.send }` leaks arbitrary-channel send capability
    // to the renderer and must be flagged the same way.
    const result = await tool({
      preloadCode: `contextBridge.exposeInMainWorld('api', { send: ipcRenderer.send, invoke: ipcRenderer.invoke });`,
    });
    assert.ok(result.includes("CRITICAL"), `expected CRITICAL finding, got:\n${result}`);
    assert.ok(result.includes("Raw ipcRenderer"));
  });

  it("does NOT flag shell.openExternal with a hardcoded https literal", async () => {
    // Regression: the previous guard `!/^https?:\/\//.test(code)` anchored
    // to start-of-string, which never matched real source -- so every
    // shell.openExternal call (even hardcoded https literals) was flagged.
    const result = await tool({
      mainCode: `shell.openExternal("https://example.com/docs");`,
    });
    assert.ok(
      !result.includes("shell.openExternal with potentially unvalidated URL"),
      `hardcoded https literal must not be flagged; got:\n${result}`,
    );
  });

  it("flags shell.openExternal with a non-literal argument", async () => {
    const result = await tool({
      mainCode: "function open(url) { shell.openExternal(url); }",
    });
    assert.ok(
      result.includes("shell.openExternal with potentially unvalidated URL"),
      `dynamic openExternal must be flagged; got:\n${result}`,
    );
  });

  it("flags shell.openExternal with a non-https hardcoded URL", async () => {
    const result = await tool({
      mainCode: `shell.openExternal("file:///etc/passwd");`,
    });
    assert.ok(
      result.includes("shell.openExternal with potentially unvalidated URL"),
      `non-https literal must be flagged; got:\n${result}`,
    );
  });

  it("flags shell.openExternal with a template-literal that interpolates a value", async () => {
    // Regression: the previous SAFE_HTTPS_LITERAL accepted any backtick body
    // that contained no quote characters, including `${userInput}`. The
    // refreshed regex disallows `${...}` interpolations in the safe branch.
    const result = await tool({
      mainCode: "shell.openExternal(`https://example.com/${userInput}`);",
    });
    assert.ok(
      result.includes("shell.openExternal with potentially unvalidated URL"),
      `template literal with interpolation must be flagged; got:\n${result}`,
    );
  });

  it("flags missing sender validation only when no origin read is present", async () => {
    // Regression: the old guard matched any mention of `event.sender`,
    // including `event.sender.send(...)` which is the OPPOSITE of
    // validation. event.sender.send must still be flagged as missing.
    const result = await tool({
      mainCode: `ipcMain.on("x", (event, msg) => { event.sender.send("reply", msg); });`,
    });
    assert.ok(
      result.includes("IPC handlers without sender validation"),
      `event.sender.send is not validation; must still flag missing sender check; got:\n${result}`,
    );
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

  it("modal parent is resolved at createWindow time, not in the static config", async () => {
    // Regression: previously emitted `parent: this.windows.get('main') ?? undefined`
    // inside the configs class-field initializer, which runs before any windows
    // are created, so parent was always undefined and modal windows were never
    // actually modal.
    const result = await tool({
      windows: [
        { id: "main", title: "Main" },
        { id: "settings", title: "Settings", type: "modal" },
      ],
    });
    assert.ok(
      !/parent:\s*this\.windows\.get\(['"]main['"]\)/.test(result),
      "configs must not contain a static parent reference into this.windows",
    );
    assert.ok(
      /if \(config\.modal[\s\S]*?this\.windows\.get\(['"]main['"]\)/.test(result),
      "createWindow must resolve the modal parent at call time from the live windows map",
    );
  });

  it("modal parent uses the first non-modal window's id, not hardcoded 'main'", async () => {
    // Regression: the modal-parent lookup was hardcoded to `this.windows.get("main")`,
    // so a config without a window named "main" produced parent-less modals.
    const result = await tool({
      windows: [
        { id: "dashboard", title: "Dashboard" },
        { id: "preferences", title: "Preferences", type: "modal" },
      ],
    });
    assert.ok(
      /this\.windows\.get\(['"]dashboard['"]\)/.test(result),
      `parent lookup should pick the first non-modal id ('dashboard'); got:\n${result}`,
    );
    assert.ok(
      !/this\.windows\.get\(['"]main['"]\)/.test(result),
      `parent lookup must not reference 'main' when no such window exists; got:\n${result}`,
    );
  });

  it("emits a no-parent fallback comment when every window is modal", async () => {
    const result = await tool({
      windows: [
        { id: "dialog-a", title: "A", type: "modal" },
        { id: "dialog-b", title: "B", type: "modal" },
      ],
    });
    assert.ok(
      /No non-modal window in the config/.test(result),
      `all-modal config must emit the no-parent comment; got:\n${result}`,
    );
    assert.ok(
      !/this\.windows\.get\(['"][^'"]+['"]\)/.test(result.split("createWindow(id: string)")[1] ?? ""),
      `all-modal config must not emit a parent lookup; got:\n${result}`,
    );
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

  // Helper: extract the status icon for a given check id from the report.
  const statusOf = (report: string, id: number): string | null => {
    const match = report.match(new RegExp(`## \\[(PASS|FAIL|WARN)\\] #${id}:`));
    return match ? match[1] : null;
  };

  it("flags unsafe-inline in CSP even without unsafe-eval", async () => {
    // Regression: previously unsafe-inline was only mentioned inside the
    // unsafe-eval branch's message string, so unsafe-inline alone incorrectly
    // reported PASS for the CSP check.
    const result = await tool({
      htmlContent: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'">`,
    });
    assert.strictEqual(statusOf(result, 6), "WARN", `CSP with unsafe-inline should WARN, got:\n${result}`);
    assert.ok(result.includes("unsafe-inline"));
  });

  it("derives supported-version window from embedded knowledge", async () => {
    // Regression: the supported floor was hardcoded to 39. Old Electron version
    // should warn; current stable should pass.
    const oldVersion = await tool({
      packageJson: `{ "devDependencies": { "electron": "^20.0.0" } }`,
    });
    assert.strictEqual(statusOf(oldVersion, 13), "WARN", `v20 should WARN, got:\n${oldVersion}`);

    const currentVersion = await tool({
      packageJson: `{ "devDependencies": { "electron": "^41.0.0" } }`,
    });
    assert.strictEqual(statusOf(currentVersion, 13), "PASS", `v41 should PASS, got:\n${currentVersion}`);
  });

  it("falls back to stable when electronVersion is unparseable", async () => {
    // Regression: parseInt("abc") is NaN, and NaN < SUPPORTED_MIN is false, so
    // the check silently passed with "Electron NaN is within the supported range".
    const result = await tool({
      packageJson: `{ "devDependencies": { "electron": "^41.0.0" } }`,
      electronVersion: "not a number",
    });
    assert.ok(!/NaN/.test(result), `must never emit NaN in the audit; got:\n${result}`);
    assert.strictEqual(statusOf(result, 13), "PASS", "unparseable input should fall back to stable and PASS");
  });

  it("detects http:// URLs in main-process loadURL calls", async () => {
    // Regression: check #1 previously only scanned browserWindowConfig, but
    // loadURL lives in main-process code, so the check almost never fired.
    const result = await tool({
      mainCode: `win.loadURL("http://example.com/app");`,
    });
    assert.strictEqual(statusOf(result, 1), "FAIL", `http:// in mainCode should FAIL #1, got:\n${result}`);
  });

  it("warns when shell.openExternal is called with non-literal input", async () => {
    const result = await tool({
      mainCode: "function open(url) { shell.openExternal(url); }",
    });
    assert.strictEqual(statusOf(result, 14), "WARN", `dynamic openExternal should WARN #14, got:\n${result}`);
  });

  it("passes #14 when every shell.openExternal call uses a hardcoded https literal", async () => {
    const result = await tool({
      mainCode: `shell.openExternal("https://example.com/docs");`,
    });
    assert.strictEqual(statusOf(result, 14), "PASS", `hardcoded https literal should PASS #14, got:\n${result}`);
  });

  it("warns on file:// usage in main code", async () => {
    const result = await tool({
      mainCode: `mainWindow.loadURL("file:///path/to/index.html");`,
    });
    assert.strictEqual(statusOf(result, 15), "WARN", `file:// should WARN #15, got:\n${result}`);
  });

  it("warns when <webview> appears in HTML", async () => {
    const result = await tool({
      htmlContent: `<html><body><webview src="https://example.com"></webview></body></html>`,
    });
    assert.strictEqual(statusOf(result, 16), "WARN", `<webview> should WARN #16, got:\n${result}`);
  });

  it("warns when BrowserWindow is created without a will-navigate handler", async () => {
    const result = await tool({
      mainCode: `const win = new BrowserWindow({});\nwin.loadURL("https://example.com");`,
    });
    assert.strictEqual(statusOf(result, 17), "WARN", `missing will-navigate should WARN #17, got:\n${result}`);
  });

  it("warns when BrowserWindow is created without setWindowOpenHandler", async () => {
    const result = await tool({
      mainCode: `const win = new BrowserWindow({});\nwin.loadURL("https://example.com");`,
    });
    assert.strictEqual(statusOf(result, 18), "WARN", `missing setWindowOpenHandler should WARN #18, got:\n${result}`);
  });

  it("warns when ipcMain handlers don't validate sender", async () => {
    const result = await tool({
      mainCode: `ipcMain.handle("read-file", async (event, path) => { return fs.readFileSync(path); });`,
    });
    assert.strictEqual(statusOf(result, 19), "WARN", `unvalidated IPC sender should WARN #19, got:\n${result}`);
  });

  it("passes #19 when sender is referenced", async () => {
    const result = await tool({
      mainCode: `ipcMain.handle("x", (event) => { const u = new URL(event.senderFrame.url); });`,
    });
    assert.strictEqual(statusOf(result, 19), "PASS", `senderFrame reference should PASS #19, got:\n${result}`);
  });

  it("does NOT pass #19 when code merely calls event.sender.send (the opposite of validation)", async () => {
    // Regression: the old regex matched any mention of `event.sender`,
    // including `event.sender.send(...)` which is a SEND, not a validation.
    const result = await tool({
      mainCode: `ipcMain.on("x", (event, msg) => { event.sender.send("reply", msg); });`,
    });
    assert.strictEqual(
      statusOf(result, 19),
      "WARN",
      `event.sender.send is not validation; #19 should WARN, got:\n${result}`,
    );
  });

  it("passes #19 when code uses sender.getURL() for origin check", async () => {
    const result = await tool({
      mainCode: `ipcMain.handle("x", (event) => { const url = event.sender.getURL(); if (!url.startsWith("file://")) throw 0; });`,
    });
    assert.strictEqual(statusOf(result, 19), "PASS", `sender.getURL reference should PASS #19, got:\n${result}`);
  });

  it("recognizes CSP set via session.webRequest.onHeadersReceived in main code", async () => {
    // Regression: check #6 previously only inspected HTML, so a project
    // setting CSP through session.webRequest (the approach this MCP's own
    // electron_configure_csp tool recommends) failed the check whenever HTML
    // wasn't also provided. The check now treats a session-set CSP as PASS.
    const result = await tool({
      mainCode: `session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": ["default-src 'self'"],
          },
        });
      });`,
    });
    assert.strictEqual(statusOf(result, 6), "PASS", `session-set CSP should PASS #6, got:\n${result}`);
  });

  it("does not run check #6 when only mainCode without a CSP signal is provided", async () => {
    // Regression guard: before the session-CSP detection landed, mainCode-only
    // inputs (no html) silently skipped #6. The new logic must preserve that
    // for inputs that show no CSP at all -- otherwise audits that only get
    // mainCode would always FAIL on missing CSP even though the user just
    // didn't include their HTML.
    const result = await tool({
      mainCode: `win.loadURL("https://example.com");`,
    });
    assert.strictEqual(statusOf(result, 6), null, `#6 should be skipped without a CSP signal; got:\n${result}`);
  });

  it("notes the static-analysis blind spots in the report footer", async () => {
    const result = await tool({
      browserWindowConfig: "{ webPreferences: { contextIsolation: true } }",
    });
    assert.ok(
      /not covered by static analysis/i.test(result),
      `report should call out static-analysis blind spots; got:\n${result}`,
    );
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

  it("honors needsInlineStyles:false in dev CSP when bundler doesn't require HMR styling", async () => {
    // Regression: dev style-src was previously hardcoded to append
    // 'unsafe-inline', silently overriding the user's input.
    const result = await tool({ needsInlineStyles: false, bundler: "none" });
    const devSection = result.match(/## Development CSP\n\n```\n([\s\S]*?)\n```/);
    assert.ok(devSection, "dev CSP block must be present");
    assert.ok(
      !/style-src[^;]*'unsafe-inline'/.test(devSection[1]),
      `dev style-src must honor needsInlineStyles:false when bundler doesn't need HMR styling; got:\n${devSection[1]}`,
    );
  });

  it("still emits unsafe-inline for vite dev style-src (HMR requires it)", async () => {
    const result = await tool({ bundler: "vite" });
    const devSection = result.match(/## Development CSP\n\n```\n([\s\S]*?)\n```/);
    assert.ok(devSection, "dev CSP block must be present");
    assert.ok(
      /style-src[^;]*'unsafe-inline'/.test(devSection[1]),
      `vite dev CSP must keep unsafe-inline so HMR styling works; got:\n${devSection[1]}`,
    );
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

  it("does NOT flag eval mentioned in a comment", async () => {
    // Regression: previous regex matched any `eval(` substring including
    // in `// avoid eval()` comments, producing false positives.
    const result = await tool({
      code: "// We deliberately avoid eval() here for safety.\nfunction add(a, b) { return a + b; }",
      fileType: "main",
    });
    assert.ok(!result.includes("eval()"), `comment-only eval mention must not flag; got:\n${result}`);
  });

  it("does NOT flag eval inside a string literal", async () => {
    const result = await tool({
      code: `const help = "Don't use eval() unless you know what you're doing";`,
      fileType: "main",
    });
    assert.ok(!result.includes("eval()"), `string-literal eval mention must not flag; got:\n${result}`);
  });

  it("does NOT flag shell.openExternal with hardcoded https literal", async () => {
    // Regression: previous heuristic flagged on any nearby `protocol ===`,
    // and missing-validation detection looked at the whole file. Each
    // call site is now examined individually.
    const result = await tool({
      code: `import { shell } from "electron";\nshell.openExternal("https://example.com/docs");`,
      fileType: "main",
    });
    assert.ok(
      !result.includes("shell.openExternal without URL validation"),
      `hardcoded https openExternal must not be flagged in lint; got:\n${result}`,
    );
  });

  it("flags shell.openExternal with dynamic argument even when an unrelated startsWith('https') exists", async () => {
    // Regression: the previous noValidation guard said "no finding if the
    // file has `startsWith('https')` ANYWHERE", which masked unrelated
    // genuinely-unvalidated call sites. The per-call check no longer
    // depends on file-wide validation traces.
    const result = await tool({
      code: `function safe(p) { return p.startsWith('https://'); }\nshell.openExternal(unsafeUrl);`,
      fileType: "main",
    });
    assert.ok(
      result.includes("shell.openExternal without URL validation"),
      `dynamic openExternal must be flagged even when file has unrelated startsWith('https'); got:\n${result}`,
    );
  });

  it("schema rejects code larger than the per-field cap", () => {
    const schema = schemaOf("electron_lint_security");
    const oversized = "a".repeat(500_001);
    const parsed = schema.safeParse({ code: oversized, fileType: "main" });
    assert.strictEqual(parsed.success, false, "expected zod to reject >500KB input");
  });

  it("scans a large benign input in under a second (ReDoS guard)", async () => {
    const big = "// safe comment\n".repeat(30_000);
    const start = Date.now();
    const result = await tool({ code: big, fileType: "main" });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `scan took ${elapsed}ms on ~500KB of benign input`);
    assert.ok(typeof result === "string" && result.length > 0);
  });

  it("points users at electron_audit_ipc_security when linting preload code (CLEAN path)", async () => {
    // Regression: lint_security with fileType=preload only checks one
    // pattern. A CLEAN here is not a comprehensive preload bill of health;
    // the report must steer users to the richer audit tool.
    const result = await tool({
      code: "const safe = 1;",
      fileType: "preload",
    });
    assert.ok(result.includes("CLEAN"));
    assert.ok(
      result.includes("electron_audit_ipc_security"),
      `preload CLEAN report must reference electron_audit_ipc_security; got:\n${result}`,
    );
  });

  it("points users at electron_audit_ipc_security when linting preload code (findings path)", async () => {
    const result = await tool({
      code: `contextBridge.exposeInMainWorld('electron', require('electron'));`,
      fileType: "preload",
    });
    assert.ok(result.includes("CRITICAL"));
    assert.ok(
      result.includes("electron_audit_ipc_security"),
      `preload findings report must also reference electron_audit_ipc_security; got:\n${result}`,
    );
  });

  it("does NOT add the preload footer to main / renderer reports", async () => {
    const result = await tool({
      code: "function safe() {}",
      fileType: "main",
    });
    assert.ok(
      !result.includes("electron_audit_ipc_security"),
      `non-preload reports should not reference the IPC audit tool; got:\n${result}`,
    );
  });
});

describe("electron_diagnose_build_error", () => {
  const tool = byName("electron_diagnose_build_error");

  it("does NOT classify a generic MODULE_NOT_FOUND as packaging when no path signal is present", async () => {
    // Regression: the Squirrel signal previously matched the bare word
    // "squirrel" anywhere in the output. A dependency name or unrelated
    // mention should not trip the packaging classifier on its own; the
    // signal is only meaningful in a path-like context.
    const result = await tool({
      errorOutput: "Error: Cannot find module 'squirrel-helpers'\nMODULE_NOT_FOUND",
      buildTool: "electron-builder",
    });
    assert.ok(
      !result.includes("Missing file or module in packaged app"),
      `bare 'squirrel' mention without a path context must not trigger the packaging classifier; got:\n${result}`,
    );
  });

  it("DOES classify Squirrel-packaged Windows path with MODULE_NOT_FOUND", async () => {
    const result = await tool({
      errorOutput:
        "Error: Cannot find module 'foo'\nMODULE_NOT_FOUND\n   at C:\\Users\\me\\AppData\\Local\\myapp\\Squirrel.exe",
      buildTool: "electron-builder",
      platform: "win32",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `path-context Squirrel match should trigger the packaging classifier; got:\n${result}`,
    );
  });

  it("identifies macOS code signing identity errors", async () => {
    const result = await tool({
      errorOutput: "Error: Code signing failed -- no signing identity found for Developer ID Application",
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

  it("does not attribute a bare MODULE_NOT_FOUND to ASAR packaging", async () => {
    // Regression: a generic "cannot find module 'foo'" from a missed devDep
    // previously triggered the ASAR/extraResources diagnosis.
    const result = await tool({
      errorOutput: "Error: Cannot find module 'some-dev-dependency'\nMODULE_NOT_FOUND",
    });
    assert.ok(
      !result.includes("Missing file or module in packaged app"),
      `bare MODULE_NOT_FOUND must not be diagnosed as ASAR packaging; got:\n${result}`,
    );
  });

  it("attributes MODULE_NOT_FOUND to packaging when the error names app.asar", async () => {
    const result = await tool({
      errorOutput:
        "ENOENT: no such file or directory, open '/Applications/MyApp.app/Contents/Resources/app.asar/foo.js'",
    });
    assert.ok(result.includes("Missing file or module in packaged app"));
  });

  it("attributes MODULE_NOT_FOUND to packaging on Windows AppData paths", async () => {
    // Regression: the packaging-issue gate previously only covered macOS
    // bundles and unix-style paths, so a Windows packaged-app failure
    // (AppData\Local\<App>\app-X.Y.Z\...) was misdiagnosed as a generic
    // missing devDep.
    const result = await tool({
      errorOutput:
        "Error: Cannot find module 'foo'\n  at C:\\Users\\jeff\\AppData\\Local\\MyApp\\app-1.0.0\\resources\\app.asar\\index.js",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `Windows packaged-app paths should trigger the ASAR diagnosis; got:\n${result}`,
    );
  });

  it("attributes MODULE_NOT_FOUND to packaging on Squirrel installer paths", async () => {
    const result = await tool({
      errorOutput: "Squirrel: failed to launch app: cannot find module 'foo'",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `Squirrel-keyword errors should trigger the ASAR diagnosis; got:\n${result}`,
    );
  });

  it("attributes MODULE_NOT_FOUND to packaging on Linux /opt/<app>/ paths (deb installs)", async () => {
    // Regression: the packaging-issue gate previously omitted Linux install
    // paths, so a deb-packaged Electron app failing to find a module showed
    // the generic "Unrecognized" diagnosis.
    const result = await tool({
      errorOutput: "Error: Cannot find module 'foo'\n  at /opt/MyApp/resources/app.asar/index.js",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `Linux /opt/<app>/ paths should trigger the ASAR diagnosis; got:\n${result}`,
    );
  });

  it("attributes MODULE_NOT_FOUND to packaging on Linux /snap/<app>/ paths", async () => {
    const result = await tool({
      errorOutput: "Error: Cannot find module 'foo'\n  at /snap/myapp/current/resources/app.asar/index.js",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `Linux /snap/<app>/ paths should trigger the ASAR diagnosis; got:\n${result}`,
    );
  });

  it("attributes MODULE_NOT_FOUND to packaging on AppImage mount paths", async () => {
    const result = await tool({
      errorOutput: "Error: Cannot find module 'foo'\n  at /tmp/.mount_MyAppABCDEF/resources/app.asar/index.js",
    });
    assert.ok(
      result.includes("Missing file or module in packaged app"),
      `AppImage mount paths should trigger the ASAR diagnosis; got:\n${result}`,
    );
  });

  it("suppresses macOS-specific diagnoses when platform is win32", async () => {
    // Regression: platform/buildTool inputs were previously silently ignored.
    // A Windows signing error should NOT produce a macOS notarization diagnosis.
    const errorOutput = [
      "Error: signtool.exe failed",
      "errSecInternalComponent -- signing identity not found",
      "notarytool: Apple notarization failed",
    ].join("\n");
    const winResult = await tool({
      errorOutput,
      platform: "win32",
      buildTool: "electron-builder",
    });
    assert.ok(winResult.includes("Scoped to platform: **win32**"), "report should declare scoping");
    assert.ok(winResult.includes("Windows code signing"), "Windows diagnosis should appear");
    assert.ok(!winResult.includes("macOS code signing identity"), "macOS identity diagnosis must be suppressed");
    assert.ok(!winResult.includes("macOS notarization failed"), "macOS notarization diagnosis must be suppressed");

    // Same input with platform=unknown should include all diagnoses.
    const allResult = await tool({ errorOutput });
    assert.ok(allResult.includes("macOS code signing identity"));
    assert.ok(allResult.includes("macOS notarization failed"));
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

  it("imports node:path since the generated code uses path.resolve", async () => {
    // Regression: the mainCode called `path.resolve(process.argv[1])` but
    // only imported `{ app, BrowserWindow }` from electron, so the scaffolded
    // file would not run.
    const result = await tool({ protocol: "myapp" });
    const match = result.match(/## Main Process\n\n```typescript\n([\s\S]*?)\n```/);
    assert.ok(match, "main process code block must be present");
    const mainCode = match[1];
    assert.ok(mainCode.includes("path.resolve"), "sanity: path.resolve is used");
    assert.ok(
      /import\s+\*\s+as\s+path\s+from\s+["']node:path["']/.test(mainCode),
      `generated deep-link code must import node:path, got:\n${mainCode}`,
    );
  });

  it("shows the caller how to wire handleDeepLinkOnLaunch into app.whenReady", async () => {
    // Regression: handleDeepLinkOnLaunch was exported by the scaffold but never
    // appeared in the usage example, so cold-start deep links on Win/Linux were
    // silently broken for anyone following the docs.
    const result = await tool({ protocol: "myapp" });
    assert.ok(/handleDeepLinkOnLaunch\(\)/.test(result), "must demonstrate calling handleDeepLinkOnLaunch()");
    assert.ok(
      /whenReady[\s\S]*handleDeepLinkOnLaunch/.test(result),
      "call site must be shown inside the app.whenReady() block",
    );
  });

  it("normalizes the deep-link path so myapp://settings parses to /settings", async () => {
    // Regression: the previous `parsed.pathname || parsed.host` form
    // emitted "settings" for myapp://settings (no leading slash),
    // breaking route matching that uses path.startsWith("/settings").
    // It also dropped the host segment for myapp://foo/bar (returned
    // "/bar" instead of "/foo/bar").
    const result = await tool({ protocol: "myapp" });
    const match = result.match(/## Main Process\n\n```typescript\n([\s\S]*?)\n```/);
    assert.ok(match, "main process code block must be present");
    const mainCode = match[1];
    assert.ok(
      /host\s*\?\s*`\/\$\{host\}\$\{rawPath\}`/.test(mainCode),
      `path normalization must combine host and pathname into a single leading-slash path; got:\n${mainCode}`,
    );
    // Sanity: the normalized 'path' is what's sent to the renderer.
    assert.ok(/send\("deep-link",\s*\{\s*path,/.test(mainCode));
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

  it("does NOT flag APIs that are still supported on the caller's electronVersion", async () => {
    // Regression: previously, every matching pattern was reported regardless
    // of `electronVersion`. session.loadExtension was deprecated in v36, so
    // a v28 user is on the supported API and should not be flagged.
    const result = await tool({
      code: `session.loadExtension('/path/to/extension');`,
      electronVersion: 28,
    });
    assert.ok(
      result.includes("CLEAN"),
      `session.loadExtension on v28 (deprecated v36) must not be flagged; got:\n${result}`,
    );
  });

  it("DOES flag APIs that are deprecated on the caller's electronVersion", async () => {
    const result = await tool({
      code: `session.loadExtension('/path/to/extension');`,
      electronVersion: 36,
    });
    assert.ok(result.includes("session.loadExtension"));
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

  it("flags eager top-level import of ML/native-bindings heavy modules", async () => {
    // Coverage for additions to the heavyModules list: onnxruntime-node,
    // @tensorflow/tfjs-node, @napi-rs/canvas, node-canvas-prebuilt.
    for (const mod of ["onnxruntime-node", "@tensorflow/tfjs-node", "@napi-rs/canvas", "node-canvas-prebuilt"]) {
      const result = await tool({
        mainCode: `import x from "${mod}";\napp.whenReady().then(() => {});`,
      });
      assert.ok(result.includes(mod), `${mod} should be flagged as eager-loaded; got:\n${result}`);
    }
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

  it("does NOT false-positive 'no bundler' when Electron Forge's Vite plugin is present", async () => {
    // Regression: the unbundled-deps check only recognized electron-vite /
    // vite / esbuild / webpack as bundler signals, missing the Forge plugin
    // setup that bundles main + preload via Vite or webpack under the hood.
    const deps = Array.from({ length: 25 }, (_, i) => `"pkg-${i}": "1.0.0"`).join(",");
    const result = await tool({
      packageJson: `{
        "dependencies": { ${deps} },
        "devDependencies": { "@electron-forge/plugin-vite": "^7.0.0" }
      }`,
    });
    assert.ok(
      !result.includes("without apparent bundler"),
      `Forge + Vite plugin must be recognized as a bundler; got:\n${result}`,
    );
  });

  it("prompts for input when nothing is provided", async () => {
    const result = await tool({});
    assert.ok(result.includes("Please provide") || result.includes("at least one"));
  });

  it("does NOT flag function-scoped lazy require of a heavy module", async () => {
    // Regression: previous regex matched any occurrence of `require("sharp")`,
    // including the recommended lazy-load pattern inside a function body.
    const result = await tool({
      mainCode: "async function processImage() {\n  const sharp = require('sharp');\n  return sharp;\n}",
    });
    assert.ok(
      !/Eager loading of heavy module: sharp/.test(result),
      `lazy require inside a function must not be flagged as eager; got:\n${result}`,
    );
  });

  it("does NOT flag dynamic import() of a heavy module", async () => {
    const result = await tool({
      mainCode: "async function process() {\n  const sharp = await import('sharp');\n  return sharp;\n}",
    });
    assert.ok(
      !/Eager loading of heavy module: sharp/.test(result),
      `await import() must not be flagged as eager; got:\n${result}`,
    );
  });

  it("does NOT flag polyfill mention in a comment", async () => {
    // Regression: previous check used `code.includes(poly)` and matched
    // any substring, including in comments.
    const result = await tool({
      rendererCode: "// We removed core-js because Electron doesn't need it\nconsole.log('hi');",
    });
    assert.ok(
      !/Unnecessary polyfill: core-js/.test(result),
      `polyfill mention in a comment must not be flagged; got:\n${result}`,
    );
  });

  it("emits a single sync-operation finding listing every matched pattern", async () => {
    // Regression: previous loop broke after the first match and lost the
    // other pattern names.
    const result = await tool({
      mainCode:
        "const x = fs.readFileSync('a.txt');\nconst y = execSync('cmd');\nconst z = fs.writeFileSync('b.txt', 'c');",
    });
    const findings = result.match(/Synchronous main-process operations:[^\n]*/g);
    assert.ok(findings && findings.length === 1, `expected one consolidated sync finding; got: ${findings?.length}`);
    assert.ok(/fs \*Sync calls/.test(findings[0]), `finding should list fs *Sync; got: ${findings[0]}`);
    assert.ok(/child_process \*Sync/.test(findings[0]), `finding should list child_process *Sync; got: ${findings[0]}`);
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

  it("advertises the narrowed supported range (v28 - v41)", async () => {
    const result = await tool({});
    assert.ok(
      /v28\s*[--]\s*v41/.test(result),
      `supported range must cover exactly what breakingChanges covers; got:\n${result}`,
    );
  });
});
