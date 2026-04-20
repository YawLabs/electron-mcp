# Changelog

All notable changes to `@yawlabs/electron-mcp` will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-20

First stable release. The tool surface is frozen: 18 tools across IPC, security, build, migration, performance, and reference categories. Future breaking changes will bump the major.

### Changed
- **Breaking:** `electron_migrate_version` now accepts `currentVersion`/`targetVersion` in the range v28–v41, matching the actual coverage of the embedded breaking-changes table. Previously the schema accepted v20–v41 but silently returned "no changes recorded" for anything below v28. Callers migrating from very old Electron should consult the official release notes directly.
- `KNOWLEDGE_VERSION.supportedRange` narrowed from `{min: 20, max: 41}` to `{min: 28, max: 41}` to reflect the truth. README updated to match.

### Added
- Per-field length caps on every code-scanning input (`preloadCode`, `mainCode`, `rendererCode`, `packageJson`, `htmlContent`, `browserWindowConfig`, `errorOutput`, `code`) so pathological inputs cannot stall regex analysis or exhaust memory. Maximum 500 KB per field.
- Length caps on scaffolder identifier/type fields (`channelName`, `args`, `returnType`, `apiNamespace`, bridge `methods[]`) so template interpolation can't be abused to produce huge outputs. Bridge `methods` array capped at 50 entries.
- Regression test: a 500 KB benign input to `electron_lint_security` must return in under a second (guards against regex-backtracking regressions).
- Integration test now asserts validation errors include the offending field name so MCP clients and their agents can act on the message.
- `electron_knowledge_version` test now pins the supported range string so a future drift between schema and advertised range is caught by CI.

## [0.2.1] — 2026-04-16

### Fixed
- `electron_scaffold_ipc_channel` no longer emits a syntactically-invalid preload bridge with a leading comma when the channel direction is `main-to-renderer`. The template now assembles method entries from an array and joins them, so only directions that produce a method contribute a member to the exposed object.
- `electron_audit_ipc_security` now catches method-reference exposure like `contextBridge.exposeInMainWorld("api", { send: ipcRenderer.send })` in addition to bare `ipcRenderer` exposure. The previous regex only matched when the object contained a bare `ipcRenderer` value.
- `electron_configure_deep_linking` generated main-process code that called `path.resolve(...)` without importing `node:path`. The scaffolded snippet now imports `path` alongside `app` and `BrowserWindow`.
- `electron_diagnose_build_error` now respects its `platform` and `buildTool` inputs — previously the schema accepted them and they were silently ignored, so a Linux/webpack caller would still get macOS-signing and electron-builder sections in the output. The report header also records the scoping.
- `electron_audit_security` (CSP check) now flags `unsafe-inline` on its own, not only when paired with `unsafe-eval`. The previous logic only surfaced `unsafe-inline` inside a message gated by the `unsafe-eval` branch.
- `electron_audit_security` version-support guidance no longer hardcodes a specific Electron version window. The supported-range floor is now derived from `KNOWLEDGE_VERSION.electronStable` so the advice stays accurate after knowledge bumps.
- `electron_audit_security` raw-`ipcRenderer`-exposure regex now uses the same bounded pattern as `electron_audit_ipc_security`, fixing false negatives on nested-brace preload objects.

### Infrastructure
- Added `.gitattributes` enforcing LF line endings for all text files so Windows contributors don't produce CRLF-tainted commits that trip Biome formatter checks.
- `release.sh` now pushes with `--follow-tags` instead of `--tags`, matching the documented YawLabs release workflow.
- Added regression tests for every bug fixed in this release.

## [0.2.0] — 2026-04-13

### Added
- New tool `electron_knowledge_version` returning metadata about the embedded Electron knowledge (last-verified date, Electron stable at verification, supported version range, source URLs).
- Knowledge-freshness footer appended to every knowledge-bearing tool response so AI consumers always know the vintage of embedded advice.
- `KNOWLEDGE.md` documenting the embedded-knowledge update checklist when Electron ships a new major.
- Integration test suite that spawns the built binary and exercises it through the real MCP SDK stdio client (tool list, tool call, error path, version subcommand, footer injection).
- Behavioral tests for every tool (previously only 4 of 17 tools had behavioral coverage). Total tests grew from 11 to 55.

### Fixed
- `electron_audit_ipc_security` no longer produces a false-positive "raw ipcRenderer exposure" finding when the preload wraps `ipcRenderer.invoke`/`.on`/`.send` inside a closure. The detection regex now only matches `ipcRenderer` when it's a bare value in the exposed object, not when it's a call target.

## [0.1.0] — 2026-04-12

### Added
- Initial release with 17 tools: IPC scaffolding (5), security auditing (4), build & distribution (4), version migration (2), performance (1), reference (1).
- Zero runtime dependencies (single bundled `dist/index.js`).
- CI release workflow on `v*` tags using org-scoped `NPM_TOKEN`.
