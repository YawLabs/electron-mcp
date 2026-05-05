# Changelog

All notable changes to `@yawlabs/electron-mcp` will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `electron_audit_ipc_security` and `electron_lint_security` no longer flag `shell.openExternal("https://example.com")` as unvalidated. The previous heuristic was `!/^https?:\/\//.test(code)` which anchored to start-of-string and so never matched real source -- every call site was reported. Both tools now examine each `shell.openExternal(arg)` call individually and treat it as safe iff the first argument is a complete `https://` string literal.
- `electron_lint_security` `shell.openExternal` validation no longer false-negatives when an unrelated `path.startsWith('https://')` exists elsewhere in the file. Validation status is now computed per call site, not by file-wide trace.
- `electron_lint_security` `eval()` and `innerHTML` checks no longer fire on text inside comments or string literals (`// avoid eval()` or `"don't use eval()"`). Both checks now run against a comment-and-string-stripped copy of the input.
- `electron_audit_performance` polyfill detection no longer fires on substring matches in comments (`// core-js is bad`). The check now matches an actual `import`/`require` of the package against a comment-stripped copy.
- `electron_audit_performance` heavy-module check no longer flags the recommended lazy-load pattern -- a `require("sharp")` inside a function body. Detection is anchored to column 0, so only top-level `import ... from "sharp"` and `const ... = require("sharp")` count as eager. `await import("sharp")` (the dynamic-import lazy form) was already correctly skipped.
- `electron_audit_performance` synchronous-operation finding no longer drops the second match. The previous loop broke after the first matched pattern and emitted a single generic finding; it now collects every matched pattern (`fs *Sync calls`, `child_process *Sync`) into one consolidated finding listing all of them.
- `electron_diagnose_build_error` ASAR/packaging diagnosis now fires on Windows packaged-app paths. The packaging-issue gate was missing `\AppData\Local\`, `\Program Files\`, NSIS-style `app-X.Y.Z\` subdirectories, and `Squirrel`; a Windows `MODULE_NOT_FOUND` from inside a packaged app was previously misdiagnosed as a missing devDep.
- `electron_configure_deep_linking` generated `handleDeepLink` no longer drops the host segment of `myapp://foo/bar`. The previous form `parsed.pathname || parsed.host` returned `/bar` (host lost) for two-segment URLs and `settings` (no leading slash) for `myapp://settings`. Generated code now combines host and pathname into a single leading-slash path so route matching is consistent across all four URL shapes (`myapp://foo`, `myapp://foo/bar`, `myapp:foo`, `myapp:/foo`).
- `electron_configure_csp` dev `style-src` now honors `needsInlineStyles: false` when the bundler is `none`. Previously dev mode hardcoded `'unsafe-inline'` regardless of input. Vite and webpack still emit `'unsafe-inline'` because their HMR style injection requires it.
- `index.ts` knowledge-footer injection now appends only to string handler returns. A future tool that returns structured (object/array) data would have produced `JSON.stringify(...) + footer` -- broken JSON. All current tools return strings; the guard is preventive.

### Added

- `electron_audit_security` covers six additional checks from the official Electron security checklist: shell.openExternal validation (#14), file:// protocol usage (#15), `<webview>` tag presence (#16), will-navigate handler (#17), setWindowOpenHandler (#18), and IPC sender validation (#19). Total static-input coverage moves from 13 items to 19. The audit footer now explicitly names the items that require runtime/packaging context (session permission handling, fuse configuration) so callers know what static analysis cannot reach.
- New `src/static-analysis.ts` utility with `stripComments` and `stripCommentsAndStrings` lexical scrubbers shared by every static-analysis tool. Eliminates the recurring failure mode where regex pattern matches false-positive on text inside comments or string literals.
- `src/static-analysis.test.ts` pinning the scrubber contract: comment removal, string preservation (or stripping), `//` inside `https://` URLs not treated as a comment start, escapes don't terminate strings, multi-line strings preserve newlines for line-number alignment, unterminated block comments don't infinite-loop.
- Regression tests for every fix in this release: hardcoded-https openExternal not flagged, dynamic openExternal flagged with or without unrelated `startsWith('https')` elsewhere, eval-in-comment / eval-in-string not flagged, lazy require not flagged, `await import` not flagged, polyfill-in-comment not flagged, sync-pattern finding consolidates all matches, Windows AppData path triggers ASAR diagnosis, Squirrel keyword triggers ASAR diagnosis, deep-link path normalization, dev CSP honors `needsInlineStyles:false` for `bundler: "none"`, dev CSP keeps `'unsafe-inline'` for Vite, six new audit checks with their expected pass/warn statuses.

### Changed

- `electron_audit_security` description rewritten to honestly enumerate the 19 covered items rather than claiming "all 20 official security recommendations." The two omitted items (session permissions, fuses) are surfaced in the report footer with pointers to where they live.
- Inputs to `electron_audit_security`, `electron_audit_ipc_security`, `electron_audit_performance`, and `electron_lint_security` are run through `stripComments` (preserving string contents) before pattern matching. Checks that should ignore string content too (eval, innerHTML) additionally use `stripCommentsAndStrings`.
- Integration test for the validation-error path is now SDK-version-tolerant. It accepts any of the field name, the offending value, or the words `invalid`/`validation`/`expected` -- so a minor SDK formatting change won't break the test even though the assertion still proves the error is actionable.

### Infrastructure

- Restored CI release workflow (`.github/workflows/release.yml`) that fires on `v*` tags and publishes via the org-level `NPM_TOKEN` secret with `--provenance`. Local `release.sh <version>` still works for direct releases; the script is now dual-mode (CI vs local) so the same code path runs in both. The 1.1.1 entry below explains why CI was removed; experience showed the local-only path runs into npm WebAuthn-session expiry on every release, which CI publishing avoids entirely.
- Added `.github/workflows/ci.yml` for build + lint + test on every push and pull request to main. Matrix covers Node 18 / 20 / 22.

## [1.1.1] - 2026-04-24

### Infrastructure

- Removed `.github/workflows/release.yml` and `.github/workflows/ci.yml`. Releases are now cut exclusively via `./release.sh <version>` from a maintainer's machine; lint, build, and test gates still run inside the script before publish. No behavior change in the published package.
- `release.sh` trimmed of dead CI branches (`IS_CI`, `GITHUB_REF_NAME`, `--provenance`). Tag is now pushed explicitly so lightweight tags work alongside annotated ones.

## [1.1.0] - 2026-04-24

### Fixed
- `electron_generate_window_manager` modal windows were never actually modal: the scaffolded code put `parent: this.windows.get('main')` inside a class-field initializer, which evaluates at construction time when no windows exist yet, so the `parent` option was frozen at `undefined`. Generated `createWindow` now resolves the parent at call time from the live windows map.
- `electron_audit_security` and `electron_explain_process_model` no longer emit "Electron NaN" when `electronVersion` is unparseable. `parseInt` results are guarded with `Number.isFinite` and fall back to `KNOWLEDGE_VERSION.electronStable`.
- `electron_audit_security` check #1 (HTTPS) was running against `browserWindowConfig`, which almost never contains URLs -- the check rarely fired in practice. It now scans whichever code inputs are provided and catches `http://` in main-process `loadURL`/`loadFile` calls.
- `electron_diagnose_build_error` no longer attributes every `MODULE_NOT_FOUND` to ASAR packaging. A bare "cannot find module 'foo'" (from a missed devDep) is not diagnosed; the packaging diagnosis now requires a packaging-specific signal (`app.asar`, `resourcesPath`, `extraResources`, `.app/Contents`).
- `electron_configure_deep_linking` exported `handleDeepLinkOnLaunch` but never showed the caller where to invoke it, so cold-start deep links on Windows and Linux were silently broken for anyone following the scaffold. Output now includes a "Wire into the Main Entry Point" section calling it inside `app.whenReady()`.

### Added
- `mainCode` input on `electron_audit_security`. Scanned by the HTTPS check so insecure URLs in `loadURL`/`loadFile` are caught.
- Regression tests covering every fix in this release (modal parent resolution, NaN fallback, `http://` in mainCode, bare MODULE_NOT_FOUND not misattributed, packaging-signal MODULE_NOT_FOUND is attributed, `handleDeepLinkOnLaunch` call site shown).

### Changed
- Unified severity taxonomy across every audit tool to `CRITICAL | HIGH | MEDIUM | LOW`. Previously `electron_audit_ipc_security` used `WARNING` for listener-without-cleanup and `sendSync`; both are now `LOW`. Output is markdown (no structured severity field), so downstream consumers that render the report as text are unaffected.
- Replaced Unicode punctuation in tool output with ASCII equivalents (em-dashes -> `--`, en-dashes -> `-`, arrows `-> <- <->`, `!=` for `≠`, `*` for bullets) to prevent Windows ConPTY mojibake. Box-drawing characters in ASCII-art diagrams are intentionally preserved.
- `electron_diagnose_build_error` CSP check in `electron_audit_security` dropped a redundant case-sensitive regex branch (the `/i` flag already covers both cases).
- Test suite now derives `EXPECTED_TOOL_COUNT` from the per-category tool arrays instead of hard-coding `18`, so adding a tool only requires updating one place.

### Infrastructure
- Documented the `hono` / `@hono/node-server` overrides in `CLAUDE.md`. They pin transitive dependencies of `@modelcontextprotocol/sdk`'s HTTP transport.
- Added a comment in `migration.ts` explaining why deprecated-API entries with `deprecated < 28` (e.g., `@electron/remote` deprecated v14) are intentionally kept -- the scanner reports them regardless of current version, while the migration tool filters by the v28-v41 range.

## [1.0.0] - 2026-04-20

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
