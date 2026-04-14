# Embedded Knowledge

This MCP ships static, version-aware knowledge about Electron. That knowledge has a vintage — it was accurate against the official docs at a specific point in time, and must be refreshed when Electron ships a new major.

The single source of truth for the vintage is `src/knowledge.ts`. Every tool response (except `electron_knowledge_version` itself) ends with a footer that surfaces that date to the caller.

## What's embedded

| File | Data | Updated when |
| --- | --- | --- |
| `src/tools/migration.ts` | Breaking changes per major, deprecated API table, platform support drops | Each Electron major |
| `src/tools/security.ts` | 20 official security recommendations with default-behavior cutoffs | Any security-checklist change |
| `src/tools/performance.ts` | 8 performance anti-patterns with fixes | Any performance-guide change |
| `src/tools/ipc.ts` (`explain_process_model`) | Process-model explanation with version-specific notes | Process-model changes (rare) |
| `src/tools/reference.ts` (`explain_concept`) | 8 concept explanations | Concept-level API changes |
| `src/tools/build.ts` (`diagnose_build_error`) | Error-pattern → cause → fix map for electron-builder / forge / packager | Build-tool behavior changes |

## Update checklist — when a new Electron major releases

1. **Add a breakingChanges entry.** Open `src/tools/migration.ts`, add a new key for the new major number in `breakingChanges`, and list every breaking change from the official release notes (https://www.electronjs.org/docs/latest/breaking-changes). Use the existing `{ change, migration, severity }` shape.
2. **Extend `deprecatedApis`.** Any new deprecations or removals in this release → add rows.
3. **Widen the zod range.** In `migration.ts` both `currentVersion` and `targetVersion` use `.min(20).max(N)` — bump the max to the new major.
4. **Refresh security defaults.** If the new Electron major changes a default (e.g. a new webPreferences default), update the relevant check in `src/tools/security.ts`.
5. **Bump `KNOWLEDGE_VERSION`.** In `src/knowledge.ts`:
   - `lastVerified` → today's date
   - `electronStable` → the new major
   - `supportedRange.max` → the new major
6. **Run the test suite.** `npm test`. The behavioral tests reference specific breaking-change entries; update them if you moved data around.
7. **Ship a minor version.** This is additive knowledge — use a minor bump, not a major.

## Update checklist — docs-only refreshes

If Electron updates their security checklist, performance guide, or a concept explanation mid-cycle:

1. Update the relevant tool's data.
2. Bump `KNOWLEDGE_VERSION.lastVerified` to today's date.
3. Ship a patch version.

## Official sources

- Breaking changes: https://www.electronjs.org/docs/latest/breaking-changes
- Security: https://www.electronjs.org/docs/latest/tutorial/security
- Performance: https://www.electronjs.org/docs/latest/tutorial/performance
- Releases: https://releases.electronjs.org
