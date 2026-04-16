import { z } from "zod";
import { KNOWLEDGE_VERSION } from "../knowledge.js";

export const ipcTools = [
  {
    name: "electron_scaffold_ipc_channel",
    description:
      "Generate complete IPC boilerplate for a new feature: ipcMain handler in the main process, preload bridge function with contextBridge, TypeScript type declarations, and renderer-side usage example. Produces all the files needed for a secure, type-safe IPC channel.",
    annotations: {
      title: "Scaffold IPC channel",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      channelName: z
        .string()
        .describe("The IPC channel name, e.g. 'get-user-data', 'save-settings', 'open-file-dialog'"),
      direction: z
        .enum(["renderer-to-main", "main-to-renderer", "bidirectional"])
        .describe("Communication direction for the channel"),
      description: z.string().describe("What this IPC channel does, e.g. 'Fetches user profile from the database'"),
      args: z
        .string()
        .optional()
        .describe("TypeScript type for the arguments, e.g. '{ userId: string }' or 'string'. Omit for no arguments."),
      returnType: z
        .string()
        .optional()
        .describe(
          "TypeScript type for the return value (renderer-to-main only), e.g. '{ name: string; email: string }'. Omit for void.",
        ),
      apiNamespace: z
        .string()
        .optional()
        .describe(
          "The namespace on window.electronAPI to group this under, e.g. 'users', 'settings'. Defaults to 'api'.",
        ),
    }),
    handler: async (input: {
      channelName: string;
      direction: string;
      description: string;
      args?: string;
      returnType?: string;
      apiNamespace?: string;
    }) => {
      const ns = input.apiNamespace || "api";
      const camelName = input.channelName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const argType = input.args || "void";
      const retType = input.returnType || "void";
      const hasArgs = argType !== "void";
      const hasReturn = retType !== "void";

      const sections: string[] = [];

      sections.push(`# IPC Channel: ${input.channelName}\n`);
      sections.push(`> ${input.description}\n`);

      // ── Main process handler ──
      if (input.direction === "renderer-to-main" || input.direction === "bidirectional") {
        const handler = hasReturn
          ? `// main/ipc/${input.channelName}.ts
import { ipcMain } from "electron";

export function register${camelName.charAt(0).toUpperCase() + camelName.slice(1)}Handler(): void {
  ipcMain.handle("${input.channelName}", async (_event${hasArgs ? `, args: ${argType}` : ""}): Promise<${retType}> => {
    // TODO: Implement handler logic
    // ${input.description}
    throw new Error("Not implemented");
  });
}`
          : `// main/ipc/${input.channelName}.ts
import { ipcMain } from "electron";

export function register${camelName.charAt(0).toUpperCase() + camelName.slice(1)}Handler(): void {
  ipcMain.on("${input.channelName}", (_event${hasArgs ? `, args: ${argType}` : ""}) => {
    // TODO: Implement handler logic
    // ${input.description}
  });
}`;

        sections.push(`## Main Process Handler\n\n\`\`\`typescript\n${handler}\n\`\`\``);
        sections.push(
          `Register in your main process entry point:\n\n\`\`\`typescript\nimport { register${camelName.charAt(0).toUpperCase() + camelName.slice(1)}Handler } from "./ipc/${input.channelName}.js";\n\nregister${camelName.charAt(0).toUpperCase() + camelName.slice(1)}Handler();\n\`\`\``,
        );
      }

      // ── Preload bridge ──
      // Build up the methods the exposed object should include, then join them
      // with a comma separator. Doing it this way avoids the leading-comma bug
      // that appears when `direction === "main-to-renderer"` produces no
      // invoke/send method but still needs an `on*` listener.
      const preloadMethods: string[] = [];

      if (input.direction === "renderer-to-main" || input.direction === "bidirectional") {
        const invokeOrSend = hasReturn
          ? `${camelName}: (${hasArgs ? `args: ${argType}` : ""}): Promise<${retType}> => ipcRenderer.invoke("${input.channelName}"${hasArgs ? ", args" : ""})`
          : `${camelName}: (${hasArgs ? `args: ${argType}` : ""}): void => ipcRenderer.send("${input.channelName}"${hasArgs ? ", args" : ""})`;
        preloadMethods.push(invokeOrSend);
      }

      if (input.direction === "main-to-renderer" || input.direction === "bidirectional") {
        const onMethod = `on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}: (callback: (${hasArgs ? `data: ${argType}` : ""}) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent${hasArgs ? `, data: ${argType}` : ""}) => callback(${hasArgs ? "data" : ""});
      ipcRenderer.on("${input.channelName}", handler);
      return () => ipcRenderer.removeListener("${input.channelName}", handler);
    }`;
        preloadMethods.push(onMethod);
      }

      const preload = `// preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("${ns}", {
  // ${input.description}
  ${preloadMethods.join(",\n  ")}
});`;

      sections.push(`## Preload Script\n\n\`\`\`typescript\n${preload}\n\`\`\``);

      // ── Type declarations ──
      let typeDecl: string;
      if (input.direction === "main-to-renderer") {
        typeDecl = `// src/types/electron.d.ts
interface ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api {
  on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}: (callback: (${hasArgs ? `data: ${argType}` : ""}) => void) => () => void;
}

declare global {
  interface Window {
    ${ns}: ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api;
  }
}

export {};`;
      } else if (input.direction === "bidirectional") {
        typeDecl = `// src/types/electron.d.ts
interface ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api {
  ${camelName}: (${hasArgs ? `args: ${argType}` : ""}) => ${hasReturn ? `Promise<${retType}>` : "void"};
  on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}: (callback: (${hasArgs ? `data: ${argType}` : ""}) => void) => () => void;
}

declare global {
  interface Window {
    ${ns}: ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api;
  }
}

export {};`;
      } else {
        typeDecl = `// src/types/electron.d.ts
interface ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api {
  ${camelName}: (${hasArgs ? `args: ${argType}` : ""}) => ${hasReturn ? `Promise<${retType}>` : "void"};
}

declare global {
  interface Window {
    ${ns}: ${ns.charAt(0).toUpperCase() + ns.slice(1)}Api;
  }
}

export {};`;
      }

      sections.push(`## Type Declarations\n\n\`\`\`typescript\n${typeDecl}\n\`\`\``);

      // ── Renderer usage ──
      let rendererUsage: string;
      if (input.direction === "main-to-renderer") {
        rendererUsage = `// In your renderer (React/Vue/Svelte component, etc.)
const cleanup = window.${ns}.on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}((${hasArgs ? "data" : ""}) => {
  console.log("Received from main:"${hasArgs ? ", data" : ""});
});

// Clean up listener when component unmounts
// cleanup();`;
      } else if (input.direction === "bidirectional") {
        rendererUsage = hasReturn
          ? `// In your renderer (React/Vue/Svelte component, etc.)

// Send to main and get response
const result = await window.${ns}.${camelName}(${hasArgs ? "args" : ""});

// Listen for main-initiated messages
const cleanup = window.${ns}.on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}((${hasArgs ? "data" : ""}) => {
  console.log("Received from main:"${hasArgs ? ", data" : ""});
});

// Clean up listener when component unmounts
// cleanup();`
          : `// In your renderer (React/Vue/Svelte component, etc.)

// Send to main
window.${ns}.${camelName}(${hasArgs ? "args" : ""});

// Listen for main-initiated messages
const cleanup = window.${ns}.on${camelName.charAt(0).toUpperCase() + camelName.slice(1)}((${hasArgs ? "data" : ""}) => {
  console.log("Received from main:"${hasArgs ? ", data" : ""});
});

// Clean up listener when component unmounts
// cleanup();`;
      } else {
        rendererUsage = hasReturn
          ? `// In your renderer (React/Vue/Svelte component, etc.)
const result = await window.${ns}.${camelName}(${hasArgs ? "args" : ""});
console.log(result);`
          : `// In your renderer (React/Vue/Svelte component, etc.)
window.${ns}.${camelName}(${hasArgs ? "args" : ""});`;
      }

      sections.push(`## Renderer Usage\n\n\`\`\`typescript\n${rendererUsage}\n\`\`\``);

      // ── Security notes ──
      sections.push(`## Security Notes

- The preload script wraps ipcRenderer methods in specific functions — never expose \`ipcRenderer\` directly
- Channel name \`${input.channelName}\` is hardcoded in the preload, preventing injection of arbitrary channels
- The contextBridge serializes all data via the structured clone algorithm (no functions, DOM nodes, or prototypes cross the boundary)
- ${input.direction === "renderer-to-main" || input.direction === "bidirectional" ? "Consider validating `event.senderFrame.url` in the main process handler to restrict which pages can invoke this channel" : "Main-to-renderer messages should only be sent to trusted BrowserWindow instances"}`);

      return sections.join("\n\n");
    },
  },

  {
    name: "electron_generate_preload_bridge",
    description:
      "Generate a complete, secure preload.ts with contextBridge.exposeInMainWorld for multiple API methods. Produces the preload script, TypeScript declarations for window.electronAPI, and security best practices. Use this when you need to expose several main-process APIs to the renderer at once.",
    annotations: {
      title: "Generate preload bridge",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      methods: z
        .array(
          z.object({
            name: z.string().describe("Method name exposed to renderer, e.g. 'openFile', 'saveSettings'"),
            channel: z.string().describe("IPC channel name, e.g. 'open-file', 'save-settings'"),
            type: z
              .enum(["invoke", "send", "on"])
              .describe(
                "'invoke' for request/response (ipcRenderer.invoke), 'send' for fire-and-forget (ipcRenderer.send), 'on' for listening to main process events",
              ),
            args: z.string().optional().describe("TypeScript type for arguments, e.g. '{ path: string }'"),
            returnType: z.string().optional().describe("TypeScript return type (invoke only), e.g. 'string[]'"),
            description: z.string().optional().describe("What this method does"),
          }),
        )
        .describe("Array of methods to expose through the preload bridge"),
      namespace: z
        .string()
        .optional()
        .describe("The property name on window, e.g. 'electronAPI'. Defaults to 'electronAPI'."),
    }),
    handler: async (input: {
      methods: Array<{
        name: string;
        channel: string;
        type: string;
        args?: string;
        returnType?: string;
        description?: string;
      }>;
      namespace?: string;
    }) => {
      const ns = input.namespace || "electronAPI";
      const nsType = ns.charAt(0).toUpperCase() + ns.slice(1);

      const methodLines: string[] = [];
      const typeLines: string[] = [];

      for (const m of input.methods) {
        const hasArgs = m.args && m.args !== "void";
        const desc = m.description ? `  // ${m.description}\n` : "";

        if (m.type === "invoke") {
          const ret = m.returnType || "void";
          methodLines.push(
            `${desc}    ${m.name}: (${hasArgs ? `args: ${m.args}` : ""}): Promise<${ret}> => ipcRenderer.invoke("${m.channel}"${hasArgs ? ", args" : ""}),`,
          );
          typeLines.push(`  ${m.name}(${hasArgs ? `args: ${m.args}` : ""}): Promise<${ret}>;`);
        } else if (m.type === "send") {
          methodLines.push(
            `${desc}    ${m.name}: (${hasArgs ? `args: ${m.args}` : ""}): void => ipcRenderer.send("${m.channel}"${hasArgs ? ", args" : ""}),`,
          );
          typeLines.push(`  ${m.name}(${hasArgs ? `args: ${m.args}` : ""}): void;`);
        } else {
          // on
          const argType = m.args || "unknown";
          methodLines.push(
            `${desc}    ${m.name}: (callback: (data: ${argType}) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ${argType}) => callback(data);
      ipcRenderer.on("${m.channel}", handler);
      return () => ipcRenderer.removeListener("${m.channel}", handler);
    },`,
          );
          typeLines.push(`  ${m.name}(callback: (data: ${argType}) => void): () => void;`);
        }
      }

      const preload = `// preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("${ns}", {
${methodLines.join("\n\n")}
});`;

      const types = `// src/types/electron.d.ts
export interface ${nsType} {
${typeLines.join("\n")}
}

declare global {
  interface Window {
    ${ns}: ${nsType};
  }
}`;

      const sections = [
        `# Preload Bridge: window.${ns}\n`,
        `## preload.ts\n\n\`\`\`typescript\n${preload}\n\`\`\``,
        `## Type Declarations\n\n\`\`\`typescript\n${types}\n\`\`\``,
        `## Security Checklist

- [x] Uses contextBridge.exposeInMainWorld (not direct window assignment)
- [x] Each method wraps a specific channel (no generic send/invoke exposure)
- [x] Event listeners return cleanup functions to prevent memory leaks
- [x] ipcRenderer is never exposed directly to the renderer
- [ ] Validate event.senderFrame.url in each ipcMain.handle/on handler
- [ ] Enable contextIsolation: true in BrowserWindow webPreferences (default since Electron 12)
- [ ] Enable sandbox: true in BrowserWindow webPreferences (default since Electron 20)`,
      ];

      return sections.join("\n\n");
    },
  },

  {
    name: "electron_audit_ipc_security",
    description:
      "Analyze preload script and main process IPC code for security issues. Checks for: raw ipcRenderer exposure, missing sender validation, synchronous IPC usage, listener memory leaks, prototype pollution via contextBridge, and insecure channel patterns. Provide the actual code content to analyze.",
    annotations: {
      title: "Audit IPC security",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      preloadCode: z.string().optional().describe("Content of the preload script (preload.ts/js) to analyze"),
      mainCode: z.string().optional().describe("Content of the main process IPC handler code to analyze"),
      rendererCode: z
        .string()
        .optional()
        .describe("Content of renderer code that uses IPC, to check for anti-patterns"),
    }),
    handler: async (input: { preloadCode?: string; mainCode?: string; rendererCode?: string }) => {
      const findings: Array<{ severity: string; issue: string; detail: string; fix: string }> = [];

      if (input.preloadCode) {
        const code = input.preloadCode;

        // Check for raw ipcRenderer exposure.
        // Matches `ipcRenderer` as a bare value (shorthand `{ ipcRenderer }`, `{ x: ipcRenderer }`)
        // OR a bare method reference like `{ send: ipcRenderer.send }` where `send`/`invoke`/`on` etc.
        // are passed as the exposed value directly (not as a call target inside a wrapping function).
        // `ipcRenderer.invoke('x')` inside a closure still won't match because `(` is not in the
        // terminator set — only object/object-member terminators are.
        const rawExposureRe =
          /contextBridge\.exposeInMainWorld[\s\S]*?\bipcRenderer(?:\.(?:send|invoke|on|once|sendSync|postMessage|sendTo|sendToHost|removeListener|removeAllListeners))?\s*(?:[,}]|$)/;
        if (rawExposureRe.test(code)) {
          findings.push({
            severity: "CRITICAL",
            issue: "Raw ipcRenderer exposed through contextBridge",
            detail:
              "Passing ipcRenderer directly (or its methods like .send, .invoke, .on) allows the renderer to send messages on ANY channel, bypassing your intended API surface. This enables prototype pollution attacks.",
            fix: "Wrap each IPC call in a dedicated function that hardcodes the channel name:\n```typescript\n// BAD\ncontextBridge.exposeInMainWorld('api', { ipcRenderer })\n\n// GOOD\ncontextBridge.exposeInMainWorld('api', {\n  getData: () => ipcRenderer.invoke('get-data')\n})\n```",
          });
        }

        // Check for ipcRenderer.on without cleanup
        if (/ipcRenderer\.on\s*\(/.test(code) && !/removeListener|removeAllListeners/.test(code)) {
          findings.push({
            severity: "WARNING",
            issue: "IPC listener without cleanup function",
            detail:
              "ipcRenderer.on() listeners persist across page navigations in SPAs. Without a cleanup mechanism, listeners accumulate and cause memory leaks.",
            fix: "Return a cleanup function that removes the listener:\n```typescript\nonUpdate: (callback) => {\n  const handler = (_event, data) => callback(data);\n  ipcRenderer.on('update', handler);\n  return () => ipcRenderer.removeListener('update', handler);\n}\n```",
          });
        }

        // Check for sendSync
        if (/ipcRenderer\.sendSync\s*\(/.test(code)) {
          findings.push({
            severity: "WARNING",
            issue: "Synchronous IPC (ipcRenderer.sendSync) detected",
            detail:
              "sendSync blocks the entire renderer process until the main process responds. This causes the UI to freeze and is almost never necessary since Electron 7 introduced ipcRenderer.invoke().",
            fix: "Replace with ipcRenderer.invoke() and ipcMain.handle():\n```typescript\n// BAD\nconst result = ipcRenderer.sendSync('get-data');\n\n// GOOD\nconst result = await ipcRenderer.invoke('get-data');\n```",
          });
        }

        // Check for nodeIntegration-style patterns
        if (/require\s*\(\s*['"]electron['"]\s*\)/.test(code) && !/contextBridge/.test(code)) {
          findings.push({
            severity: "CRITICAL",
            issue: "Electron imported without contextBridge usage",
            detail:
              "This preload script imports electron but doesn't use contextBridge, suggesting it may be relying on nodeIntegration or disabled contextIsolation.",
            fix: "Use contextBridge.exposeInMainWorld() to safely expose APIs to the renderer.",
          });
        }

        // Check for window.* direct assignment
        if (/(?:window|globalThis)\.\w+\s*=/.test(code)) {
          findings.push({
            severity: "HIGH",
            issue: "Direct window property assignment in preload",
            detail:
              "Assigning directly to window.* bypasses contextBridge protections when contextIsolation is enabled (the property won't be visible in the renderer). If contextIsolation is disabled, this is a security risk as renderer code can modify the prototype chain.",
            fix: "Use contextBridge.exposeInMainWorld() instead of direct window assignment.",
          });
        }
      }

      if (input.mainCode) {
        const code = input.mainCode;

        // Check for missing sender validation
        if (/ipcMain\.(handle|on)\s*\(/.test(code) && !/senderFrame|sender\.url|event\.sender/.test(code)) {
          findings.push({
            severity: "MEDIUM",
            issue: "IPC handlers without sender validation",
            detail:
              "IPC handlers don't validate the sender's origin. Any renderer (including injected web content in a webview) can invoke these handlers.",
            fix: "Validate event.senderFrame.url in security-sensitive handlers:\n```typescript\nipcMain.handle('sensitive-action', (event, args) => {\n  const url = new URL(event.senderFrame.url);\n  if (url.protocol !== 'file:' && url.origin !== 'https://your-app.com') {\n    throw new Error('Unauthorized');\n  }\n  // ... handle\n});\n```",
          });
        }

        // Check for shell.openExternal with dynamic input
        if (/shell\.openExternal\s*\(/.test(code) && !/^https?:\/\//.test(code)) {
          findings.push({
            severity: "HIGH",
            issue: "shell.openExternal with potentially unvalidated URL",
            detail:
              "shell.openExternal can execute arbitrary commands via protocol handlers (e.g., file://, smb://). If the URL comes from user input or renderer, it must be validated.",
            fix: "Validate the URL protocol before opening:\n```typescript\nconst url = new URL(untrustedUrl);\nif (url.protocol === 'https:' || url.protocol === 'http:') {\n  shell.openExternal(url.toString());\n}\n```",
          });
        }
      }

      if (input.rendererCode) {
        const code = input.rendererCode;

        // Check for direct require('electron') in renderer
        if (/require\s*\(\s*['"]electron['"]\s*\)/.test(code) || /from\s+['"]electron['"]/.test(code)) {
          findings.push({
            severity: "CRITICAL",
            issue: "Direct electron import in renderer code",
            detail:
              "Importing electron directly in the renderer requires nodeIntegration to be enabled, which is a major security risk. The renderer should only access Electron APIs through the preload bridge (window.electronAPI).",
            fix: "Access Electron features through the preload bridge:\n```typescript\n// BAD (renderer)\nimport { ipcRenderer } from 'electron';\n\n// GOOD (renderer)\nwindow.electronAPI.myMethod();\n```",
          });
        }
      }

      if (!input.preloadCode && !input.mainCode && !input.rendererCode) {
        return "Please provide at least one of: preloadCode, mainCode, or rendererCode to analyze.";
      }

      if (findings.length === 0) {
        return "# IPC Security Audit: PASSED\n\nNo security issues detected in the provided code. Note: this is a static analysis — always review the full application context.";
      }

      const sorted = findings.sort((a, b) => {
        const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, WARNING: 3 };
        return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
      });

      const critCount = sorted.filter((f) => f.severity === "CRITICAL").length;
      const highCount = sorted.filter((f) => f.severity === "HIGH").length;

      let header = `# IPC Security Audit: ${critCount > 0 ? "FAIL" : highCount > 0 ? "NEEDS ATTENTION" : "WARNINGS"}\n\n`;
      header += `Found ${findings.length} issue(s): ${critCount} critical, ${highCount} high, ${findings.length - critCount - highCount} other\n`;

      const body = sorted
        .map((f, i) => `## ${i + 1}. [${f.severity}] ${f.issue}\n\n${f.detail}\n\n### Fix\n\n${f.fix}`)
        .join("\n\n---\n\n");

      return `${header}\n${body}`;
    },
  },

  {
    name: "electron_generate_window_manager",
    description:
      "Generate multi-window management boilerplate for Electron apps. Creates a WindowManager class that handles window lifecycle, inter-window communication, window state persistence, and proper cleanup. Supports common patterns like main + child windows, modal dialogs, and detached panels.",
    annotations: {
      title: "Generate window manager",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      windows: z
        .array(
          z.object({
            id: z.string().describe("Unique window identifier, e.g. 'main', 'settings', 'about'"),
            title: z.string().describe("Window title"),
            width: z.number().optional().describe("Window width in pixels (default 800)"),
            height: z.number().optional().describe("Window height in pixels (default 600)"),
            type: z
              .enum(["normal", "modal", "panel"])
              .optional()
              .describe("Window type: normal (default), modal (blocks parent), or panel (always-on-top utility)"),
            url: z
              .string()
              .optional()
              .describe("URL or file path to load, e.g. '/settings.html' or '/index.html#/settings'"),
          }),
        )
        .describe("Windows to manage"),
      persistState: z
        .boolean()
        .optional()
        .describe("Whether to persist window positions/sizes across restarts (default true)"),
    }),
    handler: async (input: {
      windows: Array<{
        id: string;
        title: string;
        width?: number;
        height?: number;
        type?: string;
        url?: string;
      }>;
      persistState?: boolean;
    }) => {
      const persist = input.persistState !== false;

      const windowConfigs = input.windows
        .map((w) => {
          const type = w.type || "normal";
          const opts: string[] = [
            `      title: "${w.title}",`,
            `      width: ${w.width || 800},`,
            `      height: ${w.height || 600},`,
          ];
          if (type === "modal") {
            opts.push("      modal: true,");
            opts.push("      parent: this.windows.get('main') ?? undefined,");
          }
          if (type === "panel") {
            opts.push("      alwaysOnTop: true,");
            opts.push('      type: "panel",');
          }
          opts.push("      webPreferences: {");
          opts.push('        preload: path.join(__dirname, "preload.js"),');
          opts.push("        contextIsolation: true,");
          opts.push("        sandbox: true,");
          opts.push("      },");
          return `    "${w.id}": {\n${opts.join("\n")}\n    }`;
        })
        .join(",\n");

      const loadCases = input.windows
        .map((w) => {
          const url = w.url || (w.id === "main" ? "/" : `/${w.id}.html`);
          return `      case "${w.id}":
        if (isDev) {
          win.loadURL(\`\${DEV_URL}${url}\`);
        } else {
          win.loadFile(path.join(__dirname, "../renderer${url}"));
        }
        break;`;
        })
        .join("\n");

      const stateCode = persist
        ? `
  private loadWindowState(id: string): { x?: number; y?: number; width: number; height: number } | null {
    try {
      const statePath = path.join(app.getPath("userData"), "window-state.json");
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      return data[id] || null;
    } catch {
      return null;
    }
  }

  private saveWindowState(id: string, win: BrowserWindow): void {
    try {
      const statePath = path.join(app.getPath("userData"), "window-state.json");
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      } catch { /* first save */ }
      const bounds = win.getBounds();
      data[id] = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch { /* non-critical */ }
  }`
        : "";

      const stateRestore = persist
        ? `
    // Restore saved position/size
    const savedState = this.loadWindowState(id);
    if (savedState) {
      Object.assign(opts, savedState);
    }`
        : "";

      const stateSave = persist
        ? `
    win.on("close", () => {
      this.saveWindowState(id, win);
    });`
        : "";

      const code = `// src/main/window-manager.ts
import { BrowserWindow, app } from "electron";
import * as path from "node:path";${persist ? '\nimport * as fs from "node:fs";' : ""}

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_DEV_URL || "http://localhost:5173";

interface WindowConfig {
  title: string;
  width: number;
  height: number;
  modal?: boolean;
  parent?: BrowserWindow;
  alwaysOnTop?: boolean;
  type?: string;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    sandbox: boolean;
  };
}

export class WindowManager {
  private windows = new Map<string, BrowserWindow>();

  private configs: Record<string, WindowConfig> = {
${windowConfigs}
  };
${stateCode}

  createWindow(id: string): BrowserWindow {
    // Return existing window if already open
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }

    const config = this.configs[id];
    if (!config) {
      throw new Error(\`Unknown window: \${id}\`);
    }

    const opts = { ...config };${stateRestore}

    const win = new BrowserWindow(opts);
    this.windows.set(id, win);

    win.on("closed", () => {
      this.windows.delete(id);
    });${stateSave}

    this.loadContent(id, win);
    return win;
  }

  private loadContent(id: string, win: BrowserWindow): void {
    switch (id) {
${loadCases}
      default:
        throw new Error(\`No content configured for window: \${id}\`);
    }
  }

  getWindow(id: string): BrowserWindow | undefined {
    const win = this.windows.get(id);
    return win && !win.isDestroyed() ? win : undefined;
  }

  sendToWindow(id: string, channel: string, ...args: unknown[]): void {
    const win = this.getWindow(id);
    if (win) {
      win.webContents.send(channel, ...args);
    }
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const [, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    }
  }

  closeAll(): void {
    for (const [, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
  }

  get openWindowIds(): string[] {
    return [...this.windows.entries()]
      .filter(([, win]) => !win.isDestroyed())
      .map(([id]) => id);
  }
}

export const windowManager = new WindowManager();`;

      const usage = `// src/main/index.ts
import { app } from "electron";
import { windowManager } from "./window-manager.js";

app.whenReady().then(() => {
  windowManager.createWindow("main");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (windowManager.openWindowIds.length === 0) {
    windowManager.createWindow("main");
  }
});

// Open other windows as needed:
// windowManager.createWindow("settings");
// windowManager.sendToWindow("main", "data-updated", payload);
// windowManager.broadcast("theme-changed", "dark");`;

      return `# Window Manager\n\n## window-manager.ts\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n## Usage in main process\n\n\`\`\`typescript\n${usage}\n\`\`\``;
    },
  },

  {
    name: "electron_explain_process_model",
    description:
      "Get a clear, version-aware explanation of Electron's multi-process architecture. Covers the main process, renderer processes, preload scripts, utility processes, contextBridge, and how they interact. Useful for understanding the mental model before building features.",
    annotations: {
      title: "Explain Electron process model",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      topic: z
        .enum([
          "overview",
          "main-process",
          "renderer-process",
          "preload-scripts",
          "context-isolation",
          "sandbox",
          "utility-process",
          "ipc-patterns",
        ])
        .describe("Which aspect of the process model to explain"),
      electronVersion: z
        .string()
        .optional()
        .describe("Target Electron version for version-specific guidance (e.g. '28', '33', '41'). Defaults to latest."),
    }),
    handler: async (input: { topic: string; electronVersion?: string }) => {
      const ver = input.electronVersion ? Number.parseInt(input.electronVersion, 10) : KNOWLEDGE_VERSION.electronStable;

      const explanations: Record<string, string> = {
        overview: `# Electron Process Model Overview

Electron apps run in multiple processes, similar to Chromium:

\`\`\`
┌─────────────────────────────────────────────┐
│                MAIN PROCESS                  │
│  (Node.js — one per app)                    │
│                                              │
│  • App lifecycle (app module)               │
│  • Creates BrowserWindows                   │
│  • Native APIs (dialog, menu, tray, etc.)   │
│  • IPC handler (ipcMain)                    │
│  • File system, networking, databases       │
├─────────────────────────────────────────────┤
│         ▲ IPC (structured clone) ▼          │
├──────────────┬──────────────┬───────────────┤
│  RENDERER 1  │  RENDERER 2  │  RENDERER N   │
│  (Chromium)  │  (Chromium)  │  (Chromium)   │
│              │              │               │
│  • HTML/CSS  │  • HTML/CSS  │  • HTML/CSS   │
│  • React/Vue │  • React/Vue │  • React/Vue  │
│  • DOM APIs  │  • DOM APIs  │  • DOM APIs   │
│              │              │               │
│  preload.js  │  preload.js  │  preload.js   │
│  (bridge)    │  (bridge)    │  (bridge)     │
└──────────────┴──────────────┴───────────────┘
\`\`\`

## Key Rules

1. **Main process** = Node.js. Has full OS access. There is exactly one.
2. **Renderer process** = Chromium tab. One per BrowserWindow. ${ver >= 20 ? "Sandboxed by default (Electron 20+)." : "Not sandboxed by default in your version — consider enabling it."}
3. **Preload script** = Runs in the renderer but ${ver >= 12 ? "in an isolated context (contextIsolation, default since Electron 12)" : "shares the window context in your version — enable contextIsolation for security"}. It bridges main ↔ renderer via contextBridge.
4. **IPC** = The ONLY way to communicate between processes. Data is serialized via structured clone (no functions, no DOM nodes, no class instances).
5. **No shared memory** — processes cannot access each other's variables directly.`,

        "main-process": `# Main Process

The main process is the entry point of your Electron app. It runs Node.js and has full access to the operating system.

## Responsibilities

- **App lifecycle**: startup, quit, single-instance lock
- **Window management**: creating/destroying BrowserWindows
- **Native features**: menus, dialogs, notifications, tray, global shortcuts
- **System integration**: protocol handlers, deep links, file associations
- **IPC handlers**: responding to renderer requests via ipcMain.handle()
- **Background work**: database access, file I/O, networking

## What runs here

\`\`\`typescript
// main.ts — this is your main process
import { app, BrowserWindow, ipcMain } from "electron";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,  // ${ver >= 12 ? "default since Electron 12" : "set explicitly for your version"}
      sandbox: true,            // ${ver >= 20 ? "default since Electron 20" : "set explicitly for your version"}
    },
  });
  win.loadFile("index.html");
});

// Handle renderer requests
ipcMain.handle("read-file", async (event, filePath: string) => {
  return fs.promises.readFile(filePath, "utf-8");
});
\`\`\`

## Common mistakes

- **Blocking the main process**: Heavy computation or synchronous I/O freezes ALL windows. Use utility processes or worker threads.
- **Not handling app lifecycle on macOS**: macOS apps stay running when all windows close. Handle the \`activate\` event to recreate windows.
- **Creating too many BrowserWindows**: Each window costs 150-250MB. Consider BrowserView or tabs instead.`,

        "renderer-process": `# Renderer Process

Each BrowserWindow runs in its own renderer process — essentially a Chromium tab.

## What it can do

- Everything a web page can: DOM, CSS, Canvas, WebGL, Web Workers, fetch, WebSocket
- Use any frontend framework: React, Vue, Svelte, Angular, vanilla JS
- Access the window.electronAPI bridge (exposed by the preload script)

## What it CANNOT do${ver >= 20 ? " (sandboxed by default since Electron 20)" : ""}

- Access Node.js APIs (fs, path, child_process, etc.)
- Import native modules
- Access the file system directly
- Create system dialogs, menus, or tray icons
- Directly communicate with other renderer processes

## How it accesses main process features

\`\`\`typescript
// In the renderer — uses the preload bridge, NOT electron imports
const fileContent = await window.electronAPI.readFile("/path/to/file");
\`\`\`

## Common mistakes

- **Importing electron in the renderer**: \`import { ipcRenderer } from 'electron'\` requires nodeIntegration — a security risk. Use the preload bridge instead.
- **Thinking \`require\` works**: ${ver >= 20 ? "With sandbox enabled (default), require() is not available in the renderer." : "With sandbox enabled, require() is not available in the renderer."} Use a bundler (Vite, webpack).
- **Heavy computation in the renderer**: Blocks the UI thread. Use Web Workers or offload to the main process / utility process.`,

        "preload-scripts": `# Preload Scripts

The preload script is the bridge between main and renderer processes. It runs in the renderer's context but has access to a limited set of Node.js and Electron APIs.

## Available APIs in preload

${ver >= 20 ? "With sandbox enabled (default since Electron 20):" : "With sandbox enabled:"}

- \`contextBridge\` — expose APIs to the renderer
- \`ipcRenderer\` — communicate with main process
- \`webFrame\` — control rendering
- \`webUtils\` — file path utilities
- Basic Node.js: \`Buffer\`, \`process\` (limited), \`clearImmediate\`, \`setImmediate\`, \`timers\`

**NOT available** (with sandbox): \`require\`, \`fs\`, \`path\`, \`child_process\`, or any other Node.js module.

## The correct pattern

\`\`\`typescript
// preload.ts
import { contextBridge, ipcRenderer } from "electron";

// GOOD: Expose specific, wrapped methods
contextBridge.exposeInMainWorld("electronAPI", {
  readFile: (path: string) => ipcRenderer.invoke("read-file", path),
  onUpdate: (callback: (data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on("update", handler);
    return () => ipcRenderer.removeListener("update", handler);
  },
});
\`\`\`

## Anti-patterns

\`\`\`typescript
// BAD: Exposing ipcRenderer directly
contextBridge.exposeInMainWorld("api", {
  send: ipcRenderer.send,        // Allows ANY channel
  invoke: ipcRenderer.invoke,    // Allows ANY channel
  on: ipcRenderer.on,            // Leaks event object + prototype
});

// BAD: Direct window assignment (bypassed by contextIsolation)
window.myAPI = { send: ipcRenderer.send };

// BAD: Exposing the entire module
contextBridge.exposeInMainWorld("electron", require("electron"));
\`\`\``,

        "context-isolation": `# Context Isolation

${ver >= 12 ? "**Enabled by default since Electron 12.** Your version has this on by default." : "**Not enabled by default in your Electron version.** You should enable it explicitly."}

## What it does

Context isolation runs the preload script in a separate JavaScript context from the renderer page. This means:

- The renderer page CANNOT access preload variables, functions, or prototypes
- The preload CANNOT access renderer page variables
- \`window\` in the preload and \`window\` in the renderer are different objects
- The only bridge is \`contextBridge.exposeInMainWorld()\`

## Why it matters

Without context isolation, a compromised renderer (e.g., via XSS in loaded web content) could:

1. Override preload functions to intercept IPC calls
2. Modify prototypes to hijack \`ipcRenderer.invoke\`
3. Access Node.js APIs exposed to the preload

## Configuration

\`\`\`typescript
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,  // ${ver >= 12 ? "default" : "SET THIS"}
    preload: path.join(__dirname, "preload.js"),
  },
});
\`\`\`

## The mental model

\`\`\`
┌─────────────────────────────────────┐
│         Renderer Process            │
│                                     │
│  ┌──────────────┐ ┌──────────────┐ │
│  │ Preload      │ │ Web Page     │ │
│  │ Context      │ │ Context      │ │
│  │              │ │              │ │
│  │ ipcRenderer  │ │ React/Vue    │ │
│  │ contextBridge│ │ Your app UI  │ │
│  │              │ │              │ │
│  │ window (A)   │ │ window (B)   │ │
│  └──────┬───────┘ └──────┬───────┘ │
│         │                 │         │
│         └──contextBridge──┘         │
│         (structured clone)          │
└─────────────────────────────────────┘
\`\`\``,

        sandbox: `# Sandbox

${ver >= 20 ? "**Enabled by default since Electron 20.** Your version has this on by default." : "**Not enabled by default in your Electron version.** You should enable it explicitly with sandbox: true."}

## What it does

The sandbox restricts the preload script to a limited set of APIs. It prevents preload from using:

- \`require()\` — can't load arbitrary Node.js modules
- \`fs\`, \`path\`, \`child_process\`, etc. — no direct file system or process access
- \`module\`, \`__filename\`, \`__dirname\` — not available

## What's still available in a sandboxed preload

- \`contextBridge\` — expose APIs to renderer
- \`ipcRenderer\` — communicate with main process
- \`webFrame\` — control rendering
- \`webUtils\` — file utilities
- \`process\` — limited (versions, platform, env subset)
- \`Buffer\`, timers

## How to work with it

Since preload can't use \`require()\`, you need a bundler to compile your preload:

\`\`\`typescript
// vite.config.ts (electron-vite)
export default defineConfig({
  main: { /* main process config */ },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],  // Keep electron as external
      },
    },
  },
  renderer: { /* renderer config */ },
});
\`\`\`

## Configuration

\`\`\`typescript
new BrowserWindow({
  webPreferences: {
    sandbox: true,  // ${ver >= 20 ? "default" : "SET THIS"}
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
  },
});
\`\`\`

## Disabling sandbox (when needed)

Some use cases require an unsandboxed preload (e.g., native module access in preload). This is a security tradeoff:

\`\`\`typescript
webPreferences: {
  sandbox: false,  // ⚠ Only if absolutely necessary
}
\`\`\`

If you disable sandbox, ensure contextIsolation remains true and never load untrusted content.`,

        "utility-process": `# Utility Processes

${ver >= 24 ? "Available since Electron 22, stable API since Electron 24." : "Available since Electron 22."}

## What are they?

Utility processes are child processes spawned by the main process that run Node.js code. They're Electron's answer to "how do I do heavy work without blocking the main process?"

## When to use them

- CPU-intensive work (image processing, data parsing, compression)
- Long-running background tasks (file watching, sync engines)
- Isolating crash-prone native modules
- Running untrusted code safely

## How they work

\`\`\`typescript
// main process
import { utilityProcess } from "electron";

const child = utilityProcess.fork(path.join(__dirname, "worker.js"));

// Send data to the utility process
child.postMessage({ type: "process-data", payload: largeData });

// Receive results
child.on("message", (result) => {
  console.log("Worker result:", result);
});

// Handle exit
child.on("exit", (code) => {
  console.log("Worker exited with code:", code);
});
\`\`\`

\`\`\`typescript
// worker.js (utility process)
process.parentPort.on("message", (e) => {
  const { type, payload } = e.data;
  if (type === "process-data") {
    const result = heavyComputation(payload);
    process.parentPort.postMessage({ type: "result", data: result });
  }
});
\`\`\`

## Utility process vs Worker Thread

| Feature | Utility Process | Worker Thread |
|---------|----------------|---------------|
| Isolation | Separate V8 + process | Separate V8, same process |
| Crash impact | Only the utility process crashes | Can crash the main process |
| Node.js APIs | Full access | Full access |
| Electron APIs | None | None |
| Communication | MessagePort (postMessage) | MessagePort (postMessage) |
| Memory | Separate heap | Shared ArrayBuffers possible |
| Use case | Crash isolation, heavy tasks | Lighter parallelism |`,

        "ipc-patterns": `# IPC Communication Patterns

## Pattern 1: Renderer → Main (request/response) — RECOMMENDED

\`\`\`typescript
// Main process
ipcMain.handle("get-user", async (event, userId: string) => {
  return await db.getUser(userId);  // Return value sent back to renderer
});

// Preload
contextBridge.exposeInMainWorld("api", {
  getUser: (id: string) => ipcRenderer.invoke("get-user", id),
});

// Renderer
const user = await window.api.getUser("123");
\`\`\`

## Pattern 2: Renderer → Main (fire-and-forget)

\`\`\`typescript
// Main process
ipcMain.on("log-event", (event, data: { action: string }) => {
  analytics.track(data.action);  // No response needed
});

// Preload
contextBridge.exposeInMainWorld("api", {
  logEvent: (action: string) => ipcRenderer.send("log-event", { action }),
});

// Renderer
window.api.logEvent("button-clicked");
\`\`\`

## Pattern 3: Main → Renderer (push)

\`\`\`typescript
// Main process
function notifyRenderer(win: BrowserWindow, data: unknown) {
  win.webContents.send("data-updated", data);
}

// Preload
contextBridge.exposeInMainWorld("api", {
  onDataUpdated: (callback: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("data-updated", handler);
    return () => ipcRenderer.removeListener("data-updated", handler);
  },
});

// Renderer
const cleanup = window.api.onDataUpdated((data) => {
  console.log("Data updated:", data);
});
// Call cleanup() when component unmounts
\`\`\`

## Pattern 4: Renderer ↔ Renderer (via MessagePort)

\`\`\`typescript
// Main process — broker the connection
ipcMain.on("request-port", (event) => {
  const { port1, port2 } = new MessageChannelMain();
  // Send one port to each renderer
  mainWindow.webContents.postMessage("port", null, [port1]);
  event.sender.postMessage("port", null, [port2]);
});

// Preload
contextBridge.exposeInMainWorld("api", {
  onPort: (callback: (port: MessagePort) => void) => {
    ipcRenderer.on("port", (event) => {
      callback(event.ports[0]);
    });
  },
});

// Renderer
window.api.onPort((port) => {
  port.onmessage = (e) => console.log("From other window:", e.data);
  port.postMessage("hello from this window");
});
\`\`\`

## Serialization rules

IPC uses the structured clone algorithm. These types WORK:
- Primitives, arrays, plain objects, Date, RegExp, Map, Set, ArrayBuffer, TypedArrays, Blob, Error

These types DO NOT WORK:
- Functions, DOM nodes, class instances, Symbol, SharedArrayBuffer (without explicit sharing)`,
      };

      const explanation = explanations[input.topic];
      if (!explanation) {
        return `Unknown topic: ${input.topic}. Available topics: ${Object.keys(explanations).join(", ")}`;
      }

      return explanation;
    },
  },
] as const;
