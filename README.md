# @yawlabs/electron-mcp

MCP server for [Electron.js](https://www.electronjs.org/) development. IPC scaffolding, security auditing, build diagnostics, version migration, and reference documentation — all from your AI assistant.

Not a runtime debugger. This MCP makes AI assistants better at *building* Electron apps.

## Quick start

```bash
npx @yawlabs/electron-mcp
```

No API keys or environment variables required.

### Claude Code

```bash
claude mcp add electron -- npx -y @yawlabs/electron-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Cursor / Windsurf

Add to your MCP config:

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

## Tools (17)

### IPC & Process Architecture

- `electron_scaffold_ipc_channel` — Generate complete IPC boilerplate: main handler, preload bridge, contextBridge, TypeScript types, and renderer usage
- `electron_generate_preload_bridge` — Generate a secure preload.ts with contextBridge for multiple API methods
- `electron_audit_ipc_security` — Analyze preload/main/renderer code for IPC security issues
- `electron_generate_window_manager` — Generate multi-window management with lifecycle tracking and inter-window communication
- `electron_explain_process_model` — Version-aware explanation of Electron's multi-process architecture

### Security

- `electron_audit_security` — Comprehensive audit against all 20 official Electron security recommendations
- `electron_configure_fuses` — Generate @electron/fuses configuration for production hardening
- `electron_configure_csp` — Generate Content Security Policy accounting for bundler and framework
- `electron_lint_security` — Static analysis for dangerous Electron patterns (shell.openExternal, @electron/remote, etc.)

### Build & Distribution

- `electron_diagnose_build_error` — Diagnose electron-builder/forge errors: signing, native modules, ASAR, paths
- `electron_configure_auto_update` — Generate complete electron-updater setup with events and platform-specific signing
- `electron_configure_deep_linking` — Generate custom protocol registration across all platforms
- `electron_scaffold_project` — Generate a secure, modern Electron project scaffold with framework integration

### Migration & Compatibility

- `electron_migrate_version` — Generate migration checklist between Electron versions with breaking changes
- `electron_check_deprecated_apis` — Scan code for deprecated or removed Electron APIs

### Performance

- `electron_audit_performance` — Detect the 8 official Electron performance anti-patterns

### Reference

- `electron_explain_concept` — Authoritative explanations of Electron concepts (process model, context isolation, sandbox, IPC, ASAR, fuses, code signing, build tools)

## Examples

**"I need to add a file picker to my Electron app"**

The assistant uses `electron_scaffold_ipc_channel` to generate the complete IPC roundtrip: main process handler with `dialog.showOpenDialog()`, preload bridge, TypeScript types, and renderer usage.

**"Is my Electron app secure?"**

The assistant uses `electron_audit_security` to check BrowserWindow config, preload scripts, and CSP against all 20 official security recommendations.

**"My electron-builder build is failing with a signing error"**

The assistant uses `electron_diagnose_build_error` to parse the error output and identify the root cause with specific fix steps.

**"I need to upgrade from Electron 32 to 41"**

The assistant uses `electron_migrate_version` to generate a complete migration checklist with breaking changes, deprecated APIs, and platform support changes.

## License

MIT
