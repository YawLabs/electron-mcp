import { z } from "zod";

const concepts: Record<string, string> = {
  "process-model": `# Electron Process Model

Electron uses a multi-process architecture inherited from Chromium:

## Main Process
- **One per app** — the entry point (your \`main.ts\` / \`main.js\`)
- Runs **Node.js** — full access to file system, network, native APIs
- Creates and manages all BrowserWindows
- Handles app lifecycle (\`app.whenReady()\`, \`app.quit()\`)
- Provides native features: menus, dialogs, tray, notifications, global shortcuts
- **Never put heavy computation here** — it blocks ALL windows

## Renderer Process
- **One per BrowserWindow** — essentially a Chromium tab
- Runs your web app (HTML/CSS/JS, React/Vue/etc.)
- Sandboxed by default (since Electron 20) — no Node.js access
- Communicates with main process ONLY through IPC via the preload bridge

## Preload Script
- Runs in the renderer's context but with limited Node.js access
- The **bridge** between main and renderer
- Uses \`contextBridge.exposeInMainWorld()\` to safely expose APIs
- Runs in an isolated JavaScript context (since Electron 12)
- Should be minimal — only IPC wrappers and contextBridge setup

## Utility Process (since Electron 22)
- Child process spawned by main for heavy work
- Full Node.js access
- Communicates via MessagePort (\`postMessage\`)
- Crashes don't take down the main process
- Use for: CPU-intensive tasks, native modules, background sync

## Communication
\`\`\`
Renderer ←→ Preload (contextBridge) ←→ Main (IPC)
Main → Utility (MessagePort)
Renderer ↔ Renderer (via Main broker or MessagePort)
\`\`\``,

  "context-isolation": `# Context Isolation

**Default: enabled since Electron 12**

Context isolation creates a separate JavaScript world for the preload script, preventing the renderer page from accessing or modifying preload globals.

## Without context isolation (INSECURE)
\`\`\`
Preload and page share the same 'window' object
→ Page can override preload functions
→ Page can access ipcRenderer directly
→ XSS in the page = full app compromise
\`\`\`

## With context isolation (SECURE)
\`\`\`
Preload 'window' ≠ Page 'window'
→ Only contextBridge.exposeInMainWorld() can cross the boundary
→ Data is serialized (structured clone) — no prototype access
→ XSS in the page can only access the exposed API surface
\`\`\`

## Key rule
Never assign to \`window\` directly in the preload. Always use \`contextBridge.exposeInMainWorld()\`.`,

  sandbox: `# Electron Sandbox

**Default: enabled since Electron 20**

The sandbox restricts what the preload script can access:

## Sandboxed (default)
Available: contextBridge, ipcRenderer, webFrame, webUtils, Buffer, timers, limited process
NOT available: require(), fs, path, child_process, __dirname, __filename

## Unsandboxed (sandbox: false)
Available: Everything above + full Node.js (require, fs, path, etc.)
Use when: Native modules in preload, legacy code that needs require()

## Important: Bundling preload
Since sandboxed preload can't use require(), you need a bundler:
- electron-vite handles this automatically
- With webpack/esbuild, compile preload.ts → preload.js with electron as external`,

  ipc: `# IPC (Inter-Process Communication)

IPC is the ONLY way to communicate between Electron processes. All data is serialized.

## The 4 patterns

### 1. Renderer → Main (request/response) — RECOMMENDED
\`ipcRenderer.invoke(channel, ...args)\` → \`ipcMain.handle(channel, handler)\`
Returns a Promise. Use for most renderer-to-main communication.

### 2. Renderer → Main (fire-and-forget)
\`ipcRenderer.send(channel, ...args)\` → \`ipcMain.on(channel, handler)\`
No response. Use for logging, analytics, non-critical notifications.

### 3. Main → Renderer (push)
\`webContents.send(channel, ...args)\` → \`ipcRenderer.on(channel, handler)\`
Main pushes data to renderer. Use for state updates, notifications.

### 4. Renderer ↔ Renderer
No direct IPC. Route through main, or use MessagePort/BroadcastChannel.

## Serialization rules
Uses structured clone algorithm:
- WORKS: primitives, arrays, objects, Date, RegExp, Map, Set, ArrayBuffer, Blob, Error
- FAILS: functions, DOM nodes, class instances, Symbol

## Common mistakes
1. Exposing raw ipcRenderer (security risk)
2. Using sendSync (blocks renderer)
3. Forgetting to clean up listeners (memory leak)
4. No sender validation in main handlers`,

  asar: `# ASAR Archives

ASAR (Atom Shell Archive) is Electron's archive format for packaging app files.

## What it does
- Bundles all app files into a single \`app.asar\` file
- Faster file reads (no directory traversal)
- Prevents casual source code access
- NOT encryption — determined users can extract it

## Common issues

### __dirname resolves inside the ASAR
\`\`\`typescript
// In development: /path/to/project/src
// In production: /path/to/app.asar/src  ← can't write here!

// Fix: use app paths for writable locations
const dataDir = app.getPath("userData"); // Writable
const appDir = app.getAppPath(); // Inside ASAR (read-only)
\`\`\`

### Native .node files can't load from ASAR
\`\`\`json
// electron-builder: unpack native modules
"build": {
  "asarUnpack": ["**/*.node", "**/native-addon/**"]
}
\`\`\`
Unpacked files go to \`app.asar.unpacked/\` alongside the ASAR.

### fs operations on ASAR paths
Some fs operations work transparently (readFile, stat, readdir).
Others DON'T (writeFile, rename, access for writing).
For writable storage, use \`app.getPath("userData")\`.`,

  fuses: `# Electron Fuses

Fuses are compile-time boolean toggles baked into the Electron binary. They disable dangerous features that can't be controlled at runtime.

## Why fuses matter
Even with proper code, an attacker who gains file access can:
- Set ELECTRON_RUN_AS_NODE=1 to use your app as a Node.js runtime
- Set NODE_OPTIONS=--require=malicious.js to inject code
- Use --inspect to attach a debugger

Fuses disable these attack vectors at the binary level.

## The fuses

| Fuse | Recommended | Effect when disabled |
|------|-------------|---------------------|
| RunAsNode | DISABLE | Blocks ELECTRON_RUN_AS_NODE env var |
| CookieEncryption | ENABLE | Encrypts cookies with OS keychain |
| NodeOptions | DISABLE | Blocks NODE_OPTIONS env var |
| NodeCliInspect | DISABLE | Blocks --inspect flag |
| EmbeddedAsarIntegrity | ENABLE | Validates ASAR hasn't been tampered with |
| OnlyLoadAppFromAsar | ENABLE | Prevents loading from loose files |
| GrantFileProtocolExtraPrivileges | DISABLE | Restricts file:// protocol capabilities |

## How to apply
Fuses are flipped AFTER packaging, modifying the Electron binary:
\`\`\`bash
npx @electron/fuses read --app /path/to/app  # Check current state
\`\`\`
Or use the Electron Forge FusesPlugin for automation.`,

  "code-signing": `# Code Signing & Notarization

## Why it matters
- **Windows**: Unsigned apps trigger SmartScreen warnings ("unknown publisher"). Auto-update requires signing.
- **macOS**: Unsigned apps can't be opened without Gatekeeper bypass. Notarization is required for distribution.
- **Linux**: No signing required for distribution.

## macOS
1. **Developer ID certificate** from Apple Developer Program ($99/year)
2. **Code sign** the app with the certificate
3. **Notarize** — upload to Apple for automated review (required since macOS 10.15)
4. **Staple** — attach the notarization ticket to the app

\`\`\`json
// electron-builder config
"mac": {
  "identity": "Developer ID Application: Your Name (TEAMID)",
  "hardenedRuntime": true,
  "notarize": true
}
\`\`\`

## Windows
Option A: **Traditional certificate** (OV/EV) from a certificate authority ($200-500/year)
Option B: **Azure Trusted Signing** (newer, cheaper, but limited availability)

\`\`\`
// Environment variables
CSC_LINK=/path/to/cert.pfx
CSC_KEY_PASSWORD=your-password
\`\`\`

## CI/CD
Store certificates as base64-encoded secrets. Import into a temporary keychain (macOS) or decode to a .pfx file (Windows) during the build step.`,

  "electron-forge-vs-electron-builder": `# Electron Forge vs electron-builder

## Electron Forge
- **Official** — maintained by the Electron team
- Uses first-party packages (@electron/packager, @electron/rebuild, etc.)
- Plugin system (Vite, webpack, fuses, auto-update publishers)
- \`npm init electron-app@latest\` scaffolding
- Better for: new projects, projects that want official support

## electron-builder
- **Community** — mature, widely used
- Rewrites build logic in-house (doesn't use @electron/packager)
- More platform targets (NSIS, AppX, DMG, snap, flatpak, AppImage, etc.)
- More auto-update providers (GitHub, S3, generic, spaces, etc.)
- \`electron-builder.yml\` or package.json config
- Better for: complex build requirements, many target formats

## electron-vite
- **Vite-focused** — fast development with HMR
- Uses electron-builder under the hood for packaging
- First-class TypeScript and framework support
- Separate Vite configs for main/preload/renderer
- Better for: Vite-based projects, fast dev experience

## Which to choose?
- **Starting fresh + want official support**: Electron Forge
- **Need many package formats or complex builds**: electron-builder
- **Want the fastest dev experience**: electron-vite`,
};

export const referenceTools = [
  {
    name: "electron_explain_concept",
    description:
      "Get a clear, authoritative explanation of an Electron concept. Counters outdated tutorial content with accurate, version-aware information. Covers: process model, context isolation, sandbox, IPC, ASAR, fuses, code signing, and build tool comparison.",
    annotations: {
      title: "Explain Electron concept",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      concept: z
        .enum([
          "process-model",
          "context-isolation",
          "sandbox",
          "ipc",
          "asar",
          "fuses",
          "code-signing",
          "electron-forge-vs-electron-builder",
        ])
        .describe("The Electron concept to explain"),
    }),
    handler: async (input: { concept: string }) => {
      const explanation = concepts[input.concept];
      if (!explanation) {
        return `Unknown concept: ${input.concept}. Available: ${Object.keys(concepts).join(", ")}`;
      }
      return explanation;
    },
  },
] as const;
