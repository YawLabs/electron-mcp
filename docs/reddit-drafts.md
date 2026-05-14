# Reddit launch drafts -- electron-mcp v1.2.3

Three subreddit-tailored drafts for announcing `@yawlabs/electron-mcp`. Each leads with the angle that subreddit cares about. All three are honest about the same caveat (regex-based static analysis, not a TypeScript parser) so reviewers across all three see consistent scope.

## Posting sequence

Stagger by ~24 hours each to avoid Reddit's anti-spam heuristics on the account:

1. **r/electronjs** first -- most targeted, most forgiving of self-promo
2. **r/ClaudeAI** -- audience uses MCPs daily, cares about server quality
3. **r/typescript** -- check rule 5 (no advertising) before posting; the draft already leans toward "interesting TS-level work" framing

Skip r/programming (mods enforce strict self-promo rules). Skip r/javascript unless the posting account has ~9:1 non-promo karma there.

**First-comment tip:** on every post, follow up immediately with a screenshot or asciinema of the IPC scaffold output. Reddit posts with media in the first comment get roughly 2x engagement.

---

## Draft 1 -- r/electronjs

### Title options

A (descriptive):
> electron-mcp -- open-source MCP server: scaffolds secure IPC, audits the 20 official security recommendations, diagnoses build errors

B (problem-led):
> I kept getting AI assistants to generate Electron code with `nodeIntegration: true`, so I built an MCP for that

### Body

I kept getting AI assistants (Claude, Cursor, etc.) to generate Electron code with `nodeIntegration: true`, raw `ipcRenderer` on `window`, missing `setWindowOpenHandler`, and `webPreferences` patterns that haven't been a default since Electron 12. So I built an MCP server that intercepts those prompts and produces correct-by-default code.

**Concrete example.** Ask your assistant "add a file picker that lets the renderer read the selected file's contents." With this MCP installed it calls `electron_scaffold_ipc_channel` and you get:

- `main/ipc/open-file.ts` -- `ipcMain.handle("open-file", ...)` with `dialog.showOpenDialog` + `fs.readFile`
- `preload.ts` -- `contextBridge.exposeInMainWorld("electronAPI", { openFile: () => ipcRenderer.invoke("open-file") })`
- TypeScript types for `window.electronAPI.openFile` returning `Promise<string>`
- Renderer-side usage example
- Security notes about validating `event.senderFrame.url`

No `nodeIntegration`. No raw `ipcRenderer` exposed. Correct on the first try.

**18 tools across:**

- **IPC** (5) -- scaffold channels, generate preload bridges, audit IPC security, generate a window manager, explain the process model
- **Security** (4) -- audit against 19 of the 20 items in [the official security checklist](https://www.electronjs.org/docs/latest/tutorial/security) (the 20th, session permissions, needs runtime context), generate `@electron/fuses` config, generate a bundler/framework-aware CSP, lint for dangerous patterns
- **Build** (4) -- diagnose electron-builder/forge errors (code signing, native module rebuilds, ASAR, entitlements, path quoting), generate `electron-updater` setup, generate cross-platform deep linking, scaffold a full project
- **Migration** (2) -- migration checklist v28 to v41 with breaking changes per major, scan source for deprecated/removed APIs
- **Performance** (1) -- detect the 8 official performance anti-patterns
- **Reference** (2) -- version-aware concept explainer + knowledge-vintage metadata

**What it's not:** regex-based static analysis, not a TypeScript parser. The audit/lint tools catch common patterns; they won't catch a CSP constructed across three files. Embedded Electron knowledge was last verified 2026-04-13 against v41 stable; every response footer declares that date.

**Install:**

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

Wrap with `cmd /c` on Windows -- since Node 20, `child_process.spawn` can't directly exec `.cmd` files.

No API keys, no env vars, no telemetry. Single bundled file with zero runtime dependencies (the published package's `dependencies` is `{}`; the Dependabot alerts on the repo are devDependencies from the MCP SDK's optional HTTP transport, which the bundle doesn't include -- this server is stdio-only).

- Repo: https://github.com/YawLabs/electron-mcp
- npm: https://www.npmjs.com/package/@yawlabs/electron-mcp
- MIT licensed

Feedback welcome -- especially on the audit checks. If you have a real-world Electron pattern that should flag and doesn't, drop a code snippet on the issue tracker and I'll add it.

---

## Draft 2 -- r/ClaudeAI

### Title

> [MCP] electron-mcp -- 18 tools for Electron development (no API keys, npx-installable, MIT)

### Body

Built an MCP that gives Claude actual competence at Electron -- instead of confidently suggesting `nodeIntegration: true` and raw `ipcRenderer` on the preload bridge.

**What Claude can now do once it's installed:**

> *"Add a file picker that lets the renderer read the selected file's contents"*
→ Claude calls `electron_scaffold_ipc_channel` and returns four files with matching types: `main/ipc/open-file.ts` (the `ipcMain.handle` with `dialog.showOpenDialog`), `preload.ts` (the `contextBridge.exposeInMainWorld` wrapper), `types/electron.d.ts` (the `window.electronAPI` declaration), and a renderer-side usage example. No `nodeIntegration`. No raw `ipcRenderer` exposed.

> *"Audit my Electron app for security -- here's main.ts and preload.ts"*
→ Claude calls `electron_audit_security` against 19 of the [20 official recommendations](https://www.electronjs.org/docs/latest/tutorial/security) (session permissions is the 20th -- needs runtime context). Graded report. PASS / FAIL / WARN per check.

> *"electron-builder is failing with: `errSecInternalComponent`"*
→ Claude calls `electron_diagnose_build_error`, identifies the macOS Keychain access issue, and returns the specific `security find-identity` fix.

> *"What breaks if we jump from Electron 32 to 41?"*
→ Claude calls `electron_migrate_version`, returns breaking changes across each major (33, 34, 35, ...), scans your code for deprecated APIs, surfaces macOS 11 deprecation in v33, etc.

> *"Generate a CSP for my Vite + React renderer"*
→ Claude calls `electron_configure_csp` -- gets a CSP that knows about Vite's dev-mode WebSocket, React's inline runtime, and blocks everything else. Plus separate dev + prod policies.

**18 tools across:** IPC (5), security (4), build & distribution (4), migration (2), performance (1), reference (2). Full list and inputs documented in the repo.

**MCP server hygiene that matters:**

- All 18 tools declare `readOnlyHint: true, destructiveHint: false, idempotentHint: true` -- Claude can call them without confirmation in any client that respects annotations
- None of them shell out, write files, or call exec. They generate code, audit code, or return reference content
- Zero runtime dependencies -- single bundled ESM file, ~80KB
- Embedded Electron knowledge declares its vintage: every response footer ends with `_Knowledge last verified 2026-04-13 (Electron v41 stable)_`
- No telemetry, no network calls, no API keys, no env vars

**What it isn't:** regex-based static analysis, not a TypeScript parser. The audit/lint tools catch common shapes (`nodeIntegration: true`, raw `ipcRenderer` on preload, `shell.openExternal` with non-literal args including template-literal interpolations). They won't catch a CSP constructed across three files. The README and footers say so explicitly.

**Install** (Claude Code / Claude Desktop / Cursor / Windsurf / VS Code use the same config):

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

On Windows, wrap with `cmd /c` since Node 20+ can't directly exec `.cmd` files.

- Repo: https://github.com/YawLabs/electron-mcp
- npm: https://www.npmjs.com/package/@yawlabs/electron-mcp
- MIT, no telemetry

Feedback on the tool surface welcome -- particularly on what other Electron patterns should be audited that aren't yet. Drop a code snippet on the issue tracker if you have a real-world case that should flag and doesn't.

---

## Draft 3 -- r/typescript

### Title

> Typed Electron IPC scaffolding via MCP -- generates handler + preload + window types from one call

### Body

I built an MCP server (Model Context Protocol -- the standard for giving AI assistants tools) that scaffolds end-to-end typed Electron IPC channels. Less about "AI doing magic," more about "the boilerplate for a single typed renderer/main round-trip is ~80 lines, and assistants get it wrong if you let them freestyle."

Ask it to add a file picker, get four files where the types flow:

```typescript
// main/ipc/open-file.ts
import { ipcMain } from "electron";

export function registerOpenFileHandler(): void {
  ipcMain.handle("open-file", async (_event, args: { multi?: boolean }): Promise<string[]> => {
    // ... handler
  });
}

// preload.ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("electronAPI", {
  openFile: (args: { multi?: boolean }): Promise<string[]> =>
    ipcRenderer.invoke("open-file", args),
});

// types/electron.d.ts
interface ElectronAPI {
  openFile(args: { multi?: boolean }): Promise<string[]>;
}
declare global {
  interface Window { electronAPI: ElectronAPI; }
}

// renderer
const paths = await window.electronAPI.openFile({ multi: true });
```

Types flow input -> main handler -> preload wrapper -> window declaration -> call site. No `any`, no `unknown`, no manual sync.

**Implementation notes for this audience:**

- TS strict mode, Node16 module resolution
- Zod for every tool's `inputSchema` (becomes the MCP JSON-Schema surface)
- esbuild bundle -- 18 tools into a single ~80KB ESM file, zero runtime deps
- 123 tests via Node's built-in test runner; regression cases for every static-analysis edge (template-literal interpolation in `shell.openExternal`, comment-only `eval()` mentions, lazy `require()` inside a function, etc.)
- Biome for lint + format (no Prettier, no ESLint)
- MIT, no telemetry, no network calls

**About AI-tooling skepticism:** all 18 tools are `readOnlyHint: true, destructiveHint: false`. They generate code, audit code, or return reference content. None of them shell out, write files, or call exec. The "AI does magic" surface is zero -- it's a search-and-template layer that produces boilerplate you'd write by hand.

What it isn't: a TypeScript parser. The audit tools are regex-based static analysis. They catch common shapes (`nodeIntegration: true`, raw `ipcRenderer` on the preload bridge, `shell.openExternal` with non-literal args including template-literal interpolations); they won't catch a CSP constructed across three files. Embedded Electron knowledge was last verified 2026-04-13 against v41 stable; every response footer declares that date.

**Install** (Claude Code / Claude Desktop / Cursor / Windsurf / VS Code):

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

`cmd /c` wrapper on Windows for the `.cmd` spawn issue.

- Repo: https://github.com/YawLabs/electron-mcp
- npm: https://www.npmjs.com/package/@yawlabs/electron-mcp

Feedback on the type-generation patterns welcome -- the preload bridge has a few shapes (`invoke` / `send` / `on` with cleanup) and I'd be curious whether anyone has a cleaner type-level approach for the cleanup-function return type pattern.
