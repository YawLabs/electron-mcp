# @yawlabs/electron-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/electron-mcp)](https://www.npmjs.com/package/@yawlabs/electron-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/electron-mcp)](https://github.com/YawLabs/electron-mcp/stargazers)
[![CI](https://github.com/YawLabs/electron-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/electron-mcp/actions/workflows/ci.yml)

**Make your AI assistant actually good at Electron.** 18 tools for the stuff AI models hallucinate about: context isolation, preload bridges, fuses, CSP, signing, auto-updates, breaking changes between majors, and the 20 official security recommendations.

This is not a runtime debugger. It is a development-intelligence layer that turns "write me some Electron code" from hit-or-miss into correct-on-the-first-try.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to mcp.hosting](https://mcp.hosting/install-button.svg)](https://mcp.hosting/install?name=Electron&command=npx&args=-y%2C%40yawlabs%2Felectron-mcp&description=Electron.js%20development%20intelligence%20-%20IPC%2C%20security%2C%20builds%2C%20migration&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Felectron-mcp)

One click adds this to your [mcp.hosting](https://mcp.hosting) account so it syncs to every MCP client you use. Or install manually below.

## Why this one?

Other Electron MCP servers give your model a shell and hope. This one doesn't.

- **IPC that isn't a security hole** — `electron_scaffold_ipc_channel` generates main handler + typed preload bridge + contextBridge exposure + renderer usage in one call. No `nodeIntegration: true`, no direct `ipcRenderer` on `window`.
- **The official security recommendations, enforced** — `electron_audit_security` checks your `BrowserWindow` config, preload scripts, and CSP against all 20 items from [electronjs.org/docs/latest/tutorial/security](https://www.electronjs.org/docs/latest/tutorial/security). Not a vibe check.
- **Version-aware migration** — `electron_migrate_version` knows the breaking changes from v28 through v41 and tells you exactly what will break when you bump. `electron_check_deprecated_apis` scans your code for APIs that were removed.
- **Build errors, explained** — `electron_diagnose_build_error` parses electron-builder/forge output and identifies root causes: Apple signing, Windows code signing, native module rebuilds, ASAR packaging, entitlements, path quoting.
- **Modern production hardening** — `electron_configure_fuses` generates the `@electron/fuses` block for disabling unused runtime features (cookie encryption, Node CLI flags, legacy load behaviour). `electron_configure_csp` generates a CSP that actually works with your bundler and framework instead of blocking your own assets.
- **Knowledge freshness is declared, not assumed** — every response includes a `_Knowledge last verified YYYY-MM-DD (Electron vN stable)_` footer. Call `electron_knowledge_version` to get the metadata directly. If your Electron is newer than the footer, the tool tells you.
- **Read-only, no side effects** — every tool declares `readOnlyHint`, `destructiveHint: false`, `idempotentHint: true`, so MCP clients can skip confirmation. The tools never touch your filesystem, never run code, never call `exec`.
- **Zero runtime dependencies** — ships as a single bundled file. No 5-minute `node_modules` install, no `electron` or `electron-builder` installed as dependencies to inflate your project.

## Quick start

No API keys. No environment variables. Just install it.

**1. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "electron": {
      "command": "npx",
      "args": ["-y", "@yawlabs/electron-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "electron": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/electron-mcp"]
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**2. Restart and approve**

Restart Claude Code (or your MCP client) and approve the Electron MCP server when prompted.

That's it. Now ask your AI assistant:

> "Add a file picker to my Electron app"
>
> "Audit my BrowserWindow config for security issues"
>
> "My electron-builder is failing with a signing error — here's the output"
>
> "Generate a CSP for my Vite + React renderer"
>
> "What breaks if I upgrade from Electron 32 to 41?"

## Alternate MCP clients

| Client | Config file |
|---|---|
| Claude Code | `.mcp.json` (project root) or `~/.claude.json` (global) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

Use the same JSON block shown above in any of these.

## Tools (18)

### IPC & process architecture (5)
- **electron_scaffold_ipc_channel** — Generate a complete IPC round-trip: main handler, preload bridge, `contextBridge` exposure, TypeScript types, renderer usage.
- **electron_generate_preload_bridge** — Generate a secure `preload.ts` with `contextBridge` for multiple API methods.
- **electron_audit_ipc_security** — Analyze preload/main/renderer code for IPC security issues (direct `ipcRenderer`, missing sender validation, channel injection).
- **electron_generate_window_manager** — Multi-window management with lifecycle tracking and inter-window communication.
- **electron_explain_process_model** — Version-aware explanation of Electron's multi-process architecture (main vs renderer vs utility, what lives where).

### Security (4)
- **electron_audit_security** — Audit against all 20 official security recommendations: BrowserWindow, preload, CSP, remote content, sandbox.
- **electron_configure_fuses** — Generate `@electron/fuses` config for production hardening (disable cookie encryption fallback, Node CLI flags, legacy load behaviour).
- **electron_configure_csp** — Generate a Content Security Policy aware of your bundler (Vite/webpack/Parcel) and framework (React/Vue/Svelte).
- **electron_lint_security** — Static analysis for dangerous patterns: `shell.openExternal` with untrusted input, `@electron/remote`, `enableBlinkFeatures`, etc.

### Build & distribution (4)
- **electron_diagnose_build_error** — Parse electron-builder/forge errors and identify root causes: code signing, native modules, ASAR, entitlements, path quoting.
- **electron_configure_auto_update** — Generate complete `electron-updater` setup with events and platform-specific signing concerns.
- **electron_configure_deep_linking** — Custom protocol registration across Windows/macOS/Linux.
- **electron_scaffold_project** — Generate a secure, modern Electron project scaffold (contextIsolation: true, sandbox: true, preload, TypeScript, chosen framework).

### Migration & compatibility (2)
- **electron_migrate_version** — Migration checklist between Electron versions with breaking changes, deprecated APIs, platform support changes.
- **electron_check_deprecated_apis** — Scan source for APIs deprecated or removed in the target Electron version.

### Performance (1)
- **electron_audit_performance** — Detect the 8 official Electron performance anti-patterns (sync I/O on main, unbounded event listeners, etc).

### Reference (2)
- **electron_explain_concept** — Authoritative explainer for 8 topics: process model, context isolation, sandbox, IPC, ASAR, fuses, code signing, build tools.
- **electron_knowledge_version** — Metadata about the embedded knowledge: last-verified date, Electron stable at verification, supported version range. Call this if an agent is unsure whether advice is current.

## Knowledge freshness

Tools that depend on embedded Electron knowledge (breaking changes, deprecated APIs, security recommendations, anti-patterns, concept explanations) append a footer like:

```
_Knowledge last verified 2026-04-13 (Electron v41 stable). For anything newer, check https://releases.electronjs.org._
```

Call `electron_knowledge_version` to get the metadata directly. When a new Electron major releases, [KNOWLEDGE.md](./KNOWLEDGE.md) documents the update process.

## Examples

### Add a file picker the safe way

```
> "Add a file picker that lets the renderer read the selected file's contents"
→ electron_scaffold_ipc_channel({
    direction: "renderer-to-main",
    channel: "open-file",
    returns: "string"
  })
  # Generates: main handler (dialog.showOpenDialog + fs.readFile),
  # preload bridge (contextBridge.exposeInMainWorld),
  # TypeScript types for window.api.openFile,
  # renderer usage example
```

### Audit an existing app's security

```
> "Check my Electron app for security issues — here's my main.ts and preload.ts"
→ electron_audit_security({ mainCode: "...", preloadCode: "..." })
  # Returns a graded report against all 20 recommendations,
  # flagging nodeIntegration, missing contextIsolation,
  # unsandboxed renderers, loose CSP, and more.
```

### Diagnose a failing signing step

```
> "electron-builder is exiting with: errSecInternalComponent — help"
→ electron_diagnose_build_error({ output: "..." })
  # Identifies macOS Keychain Access issue with code signing,
  # returns specific `security` CLI fix and CI reconfiguration.
```

### Plan an Electron major bump

```
> "We're on Electron 32. What breaks if we jump to 41?"
→ electron_migrate_version({ from: 32, to: 41, sourceCode: "..." })
  # Returns breaking changes across each major (33, 34, 35, ...),
  # deprecated APIs found in your code,
  # platform support changes,
  # recommended test plan.
```

### Generate a real CSP

```
> "Generate a CSP for my Vite + React renderer that actually works"
→ electron_configure_csp({
    bundler: "vite",
    framework: "react",
    allowedOrigins: ["https://api.mycompany.com"]
  })
  # Returns a CSP that accounts for Vite's dev-mode WebSocket,
  # React's inline runtime, and blocks everything else.
```

## Troubleshooting

**"Tool output is cut off / too long"**

- A few scaffolders produce >10KB of generated code. Ask the assistant to regenerate with a narrower scope (single channel vs multi-channel bridge; one framework scaffold vs comparison).

**"The advice is wrong for my Electron version"**

- Check `electron_knowledge_version`. If Electron has shipped a new major since the verified date, cross-check with the official breaking-changes page linked there.
- File an issue on the repo with the specific tool + version + expected vs actual. Knowledge updates ship in minor versions.

**"Windows: MCP server doesn't start"**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 18+
- No runtime dependencies

## Contributing

```bash
git clone https://github.com/YawLabs/electron-mcp.git
cd electron-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsc + esbuild bundle
npm test           # node --test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT
