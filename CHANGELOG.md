# Changelog

All notable changes to `@yawlabs/electron-mcp` will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.6] - 2026-05-16

### Fixed

- `electron_generate_window_manager` now validates each window's `id` against `/^[A-Za-z_][\w-]*$/` at the schema layer. The id is interpolated unescaped into three places in the generated code (configs object key, parent lookup, `loadCases` switch); an id with quotes, backslashes, or newlines could have broken the output or smuggled code. The schema constraint closes all three sites in one shot.
- `electron_diagnose_build_error` Squirrel boundary tightened from `(?:[\\/]|^)Squirrel[.:\\/-]` to `[\\/]Squirrel[.:\\/-]|^Squirrel:`. The earlier form's `^` alternative + `-` suffix still matched a `squirrel-helpers` line at start-of-line; the new boundary requires an actual path separator, and the start-of-line case is reserved for the runtime's `Squirrel:` log prefix.
- `electron_audit_security` check #19 and `electron_audit_ipc_security` sender-validation regex appends `\b` after `url|origin` so properties like `senderFrame.urlPath` / `senderFrame.originX` don't false-PASS the check.

### Changed

- `scripts/smoke-published.mjs` validates `SMOKE_VERSION` against `/^[\w.+-]+$/` before interpolating into the `npm install` argv. With `shell: true`, a value like `1.0.0; rm -rf ~` would have executed the rm half.

### Added

- `scripts/smoke-published.mjs` (run via `npm run smoke:published`) installs the npm package into a fresh tempdir, connects to the MCP server over stdio, and asserts a handful of representative behaviors (tool count + prefixing, `audit_security` flags `nodeIntegration: true`, knowledge footer injection, `knowledge_version` advertises the v28-v41 range, `check_deprecated_apis` respects `electronVersion`). Goes beyond release.yml's `--version` smoke -- if a tool file is dropped by esbuild or the SDK wire contract breaks, this catches it. `SMOKE_VERSION` env var lets you smoke an older release.

### Infrastructure

- 3 new regression tests covering items above. Full suite: 142/142.

## [1.2.5] - 2026-05-16

### Fixed

- `electron_audit_security` check #19 (IPC sender validation) no longer reports PASS when code merely mentions `event.sender` -- the old regex matched `event.sender.send(...)`, which is the opposite of validation. Now requires an actual origin read (`senderFrame.url`, `senderFrame.origin`, or `sender.getURL()`). `electron_audit_ipc_security` has the same tightening.
- `electron_audit_performance` unbundled-deps check no longer false-positives on Electron Forge setups. Forge's Vite and webpack plugins (`@electron-forge/plugin-vite`, `@electron-forge/plugin-webpack`) bundle main + preload under the hood but weren't recognized as bundler signals; rollup and parcel were also missed. All four are now accepted.
- `electron_lint_security` with `fileType: "preload"` now references `electron_audit_ipc_security` in its report. The lint only checks one preload pattern (full-module exposure via `contextBridge`); the richer preload checks (raw `ipcRenderer`, missing sender validation, listener leaks, direct `window.*` assignment) live in the IPC audit tool. A CLEAN here is no longer mistaken for a comprehensive preload bill of health.
- `electron_check_deprecated_apis` now filters by `electronVersion`. A v28 user calling `session.loadExtension()` (deprecated v36) no longer gets flagged for an API that's still supported on their version.
- `electron_diagnose_build_error` no longer false-matches the bare word `squirrel` in unrelated identifiers like a `squirrel-helpers` npm package. The Squirrel signal now requires path-context (`/Squirrel.`, `\Squirrel\`, `Squirrel.exe`) or the runtime's log prefix (start-of-string `Squirrel:`).
- `electron_generate_window_manager` modal windows no longer default to a parent of `this.windows.get("main")`. Configs without a window literally named `main` (or where `main` itself is the modal) previously got parent-less modals. The generator now picks the first non-modal window's id at codegen time; when every window is modal, it emits an explicit no-parent comment instead of a broken lookup.
- `electron_audit_performance` `heavyModules` detector extended to cover ML and additional native-bindings packages: `onnxruntime-node`, `@tensorflow/tfjs-node`, `@napi-rs/canvas`, `node-canvas-prebuilt`. Eager top-level imports of these now flag as expected.
- `electron_migrate_version` breaking-changes data refreshed against electronjs.org/docs/latest/breaking-changes: v28 `setTrafficLightPosition` corrected from "renamed" to "removed (replaced by `setWindowButtonPosition`)" with severity bumped MEDIUM; misplaced v28 `WebContentsView replaces BrowserView` entry removed (deprecation actually landed in v30, already present); renderer-clipboard deprecation moved from v38 to v40 (the real deprecation version); v40 entry wording corrected from "fully removed" to "deprecated (will be removed in a future version)"; matching update to the `deprecatedApis` table.
- `electron_diagnose_build_error` recommended Visual Studio Build Tools workload directly instead of `npm install --global windows-build-tools`. The npm package was deprecated by its author years ago and emits a deprecation warning on install.

### Changed

- `src/version.ts` extracted from `src/index.ts`. The tsc-path version fallback (`createRequire(import.meta.url)("../package.json")`) is now unit-tested via `src/version.test.ts`. Previously the fallback was dead from a test perspective because the integration test always loads the esbuild bundle where `__VERSION__` is defined.

### Infrastructure

- 14 new regression tests across the changes above. Full suite: 139/139 across `static-analysis.test.js`, `integration.test.js`, `version.test.js`, and `tools/tools.test.js`.

## [1.2.4] - 2026-05-15

### Added

- Automatic publishing to the Official MCP Registry (registry.modelcontextprotocol.io) via OIDC on every release. `server.json` + `mcpName` metadata added; `release.yml` gains four steps (resolve npm publisher, mint OIDC token, push to the registry, verify) that fire after the npm publish succeeds.

### Infrastructure

- `release.yml` smoke test reworked. The previous form gated on `npm view` then ran `npx -y --version`; the two calls hit different CDN paths so `npm view` could clear while `npx` still ETARGETed on a stale mirror. Now retries the actual `npx -y @yawlabs/electron-mcp@${VERSION} --version` call directly with 30 x 10s budget (~5 min upper bound, typical < 30s). Pattern mirrors aws-mcp / tailscale-mcp.
- New `.github/workflows/deprecate.yml` (manually triggered). Uses the org `NPM_TOKEN` exactly like `release.yml` so deprecation runs don't depend on a local WebAuthn session. Inputs pass through env vars (not `${{ }}` interpolation in the run script) to prevent argv injection. Shares the `release-npm` concurrency group with `release.yml` so a deprecate run can't collide with a concurrent publish. Verify step retries `npm view` for ~3 min to outlast CDN propagation.
- `package.json` overrides bumped to clear Dependabot CVEs in transitive `@modelcontextprotocol/sdk` dependencies: `hono` 4.12.14 -> 4.12.18 (JWT NumericDate, JSX SSR CSS injection, cache Vary handling), `fast-uri` pinned `>=3.1.2` (host confusion via percent-encoded authority, path traversal via percent-encoded dot segments), `ip-address` pinned `>=10.2.0` (XSS in Address6 HTML-emitting methods). End users via `npx` are unaffected -- `dist/index.js` ships zero runtime deps and uses only the stdio transport; this is dev-graph hygiene.

### Documentation

- README "all 20 official security recommendations" tightened to "19 of the 20 that can be verified from static inputs"; the 20th (session permission handling) needs runtime context and is already flagged in the report footer. Updated in tagline, Tools list, and Examples block.
- README "Zero runtime dependencies" bullet expanded to explain that the published package's `dependencies` is `{}` and any open Dependabot alerts are against devDependencies (the SDK's optional HTTP transport surface) which the bundle does not include. Preempts the "I see 7 high CVEs" question on the repo page.

## [1.2.3] - 2026-05-13

> Note: 1.2.2 was bumped locally but never tagged or published -- the test-script issue below was caught before the tag push, so 1.2.3 shipped both the full-pass audit follow-ups originally intended for 1.2.2 AND the test-script fix.

### Fixed

- `electron_audit_ipc_security` and `electron_lint_security` `shell.openExternal` checks now reject backtick template literals containing `${...}` interpolations. The previous `SAFE_HTTPS_LITERAL` regex used `[^'"`]*` for the body, which silently accepted `` `https://example.com/${userInput}` `` -- exactly the "URL composed from user input" pattern the audit is meant to catch.
- `electron_audit_security` check #6 (CSP) now treats `session.*.webRequest.onHeadersReceived` writing a `Content-Security-Policy` header in main code as a valid CSP source. Previously the check only inspected HTML; projects following this MCP's own `electron_configure_csp` recommendation (which uses the session approach) were failing the check whenever HTML wasn't also provided.
- `electron_diagnose_build_error` packaging-issue gate extended to Linux install paths. A `MODULE_NOT_FOUND` from a deb-installed app (`/opt/<app>/`, `/usr/lib/<app>/`), snap (`/snap/`), or AppImage (`/tmp/.mount_*/` or the `AppImage` keyword) is now classified as packaging instead of the generic fallback.
- `index.ts` now rejects unknown subcommands with a non-zero exit and a usage message. A typo like `electron-mcp versoin` previously fell through to the MCP server, which blocks on stdio and looks indistinguishable from a hang.

### Changed

- `migration.ts` schema bounds and the `electron_check_deprecated_apis` default version now derive from `KNOWLEDGE_VERSION.supportedRange` / `.electronStable` instead of hardcoded 28/41. Bumping the knowledge constant in one place propagates to both the migration tool's accepted version range and the deprecated-API scanner's default.
- `electron_scaffold_project` now emits a `## Note on __dirname` section in the generated main-process file explaining the bundler-vs-raw-ESM caveat (`__dirname` is provided by the bundler but does not exist in raw ESM). Heads off a common scaffold-then-strip-the-bundler confusion.

### Infrastructure

- `unsafeOpenExternalCallSites()` and `hasUnsafeOpenExternal()` extracted to `src/static-analysis.ts`. Both `electron_audit_ipc_security` and `electron_lint_security` previously had their own copies of the safe-URL detection logic; the dedup prevents the two from drifting (which is how the template-literal `${...}` bug above existed in both places).
- Test scripts switched from `node --test dist/` to an explicit file list (`dist/static-analysis.test.js dist/integration.test.js dist/tools/tools.test.js`). Node 22's directory-mode test runner discovers any `.test.*`-suffixed file AND treats `index.js` as a discoverable test entry, so on Node 22 the package's own `dist/index.js` was being spawned during the test run and hung waiting for stdio. The explicit list pins exactly what runs and works identically across Node 20 and 22.
- Regression tests for every fix in this release, plus a new `static-analysis.test.ts` describe block pinning the safe/unsafe contract of `hasUnsafeOpenExternal` (8 cases: hardcoded https double / single / template literal, template with interpolation, non-https literal, bare variable, concatenated expression, mirror against the call-sites variant).

## [1.2.1] - 2026-05-06

### Infrastructure

This release is CI/release-pipeline only -- no source-code or tool-behavior changes.

- `release.yml` now `needs: ci` -- the ci.yml workflow is reused via `workflow_call` so a release tag can't publish unless the matrix CI run on the same ref passed first. Previously release.yml ran no pre-publish checks at the workflow level (release.sh did its own lint/test internally, but failures were buried inside the Release step's log).
- `release.yml` adds a post-publish smoke test step. Once npm view sees the new version, the runner `npx`'s the freshly published package from a temp dir and asserts `--version` matches the tag. Catches packaging regressions (missing bin shebang, bad `"files"` entry, broken esbuild output) before they hit real users. `release.sh` step 7 gains a matching provenance-attestation check.
- `release.yml` adds a top-level `concurrency` block. Group key is the literal `release-npm` so back-to-back tag pushes serialize their publish jobs through one queue instead of racing on npm. `cancel-in-progress: false` so a queued run waits its turn (losing a tag's release event is worse than waiting a minute).
- `release.sh` step 4 creates an annotated tag (`git tag -a "v${VERSION}" -m "v${VERSION}"`) instead of a lightweight one. Carries metadata (tagger, date, message) and is signing-ready. Both pushes are still explicit (`git push origin main` then `git push origin "v${VERSION}"`) so a resumed run with main already on origin still lands the tag.
- `release.sh` step 5 idempotency check queries the specific version (`npm view "@yawlabs/electron-mcp@${VERSION}" version`) rather than the package's `latest` dist-tag. The bare query returns whichever version is latest on the registry, so an out-of-band higher version would have made the script try to re-publish the current one and fail with "cannot publish over previously published version". The versioned form returns the version when it exists and empty otherwise -- correct idempotency semantics.
- `release.sh` step 6 `PREV_TAG` lookup uses `git describe --tags --abbrev=0 "v${VERSION}^"` instead of sort+grep+tail on tag names. Walks the commit graph via ancestry, so a stray future tag (e.g. someone pre-tagging v2.0.0 ahead of an actual v1.x release) sorts above the current one and corrupts a name-based "previous" lookup; ancestry isn't fooled.
- `release.sh` skips its own lint and build+test passes when `CI=true`. ci.yml's `workflow_call` gate already runs them on every supported Node version, and `prepublishOnly` rebuilds + retests inside `npm publish`, so the artifact is still verified before reaching the registry. Saves ~2 min per CI release run; local invocations still gate on lint + build + test.
- `release.sh` step 2 renamed "Build & test" (it was labeled "Test" but ran build+test); the pre-flight summary mirrors the rename.
- ci.yml matrix drops Node 18 (end-of-life on 2025-04-30) and now covers Node 20 + 22. `package.json` engines field bumps to `>=20` so the supported-version contract matches what we actually test.

## [1.2.0] - 2026-05-04

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
