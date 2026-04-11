# electron-mcp

Electron.js MCP server — IPC scaffolding, security auditing, build diagnostics, and development intelligence for AI assistants.

## Architecture

- `src/index.ts` — Entry point. Registers all tools with McpServer, handles version subcommand.
- `src/tools/ipc.ts` — IPC & process architecture tools (5 tools): scaffold channels, generate preload bridges, audit IPC security, window manager, process model explanation.
- `src/tools/security.ts` — Security tools (4 tools): comprehensive audit, fuses config, CSP generation, security linting.
- `src/tools/build.ts` — Build & distribution tools (4 tools): error diagnosis, auto-update config, deep linking, project scaffolding.
- `src/tools/migration.ts` — Migration tools (2 tools): version migration checklist, deprecated API scanner. Contains embedded breaking changes database for Electron v28-v41.
- `src/tools/performance.ts` — Performance tool (1 tool): detects 8 official anti-patterns.
- `src/tools/reference.ts` — Reference tool (1 tool): authoritative concept explainer with 8 topics.

## Key differences from other @yawlabs MCPs

This MCP does NOT wrap a REST API. It is a development intelligence server:
- No API key or environment variables required
- Tools generate code and configuration rather than fetching data
- Tools analyze code provided as input (static analysis)
- Contains embedded Electron knowledge (breaking changes, security rules, best practices)
- All tools are read-only — no side effects

## Build

- **Bundler:** esbuild (`build.mjs`) — single `dist/index.js` with zero runtime deps
- **Type checking:** tsc (separate pass before esbuild)
- **Linter:** Biome
- **Tests:** Node.js built-in test runner (`node --test`)
- **TypeScript:** Strict mode, ES2022 target, Node16 module resolution

## Key patterns

- Tools are arrays of `{ name, description, annotations, inputSchema, handler }` objects
- All tool names prefixed with `electron_`
- Zod schemas for input validation with `.describe()` for each field
- Every tool has MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- All tools return markdown-formatted strings (not JSON)
- Version injected at build time via esbuild `define`

## Release process

Run `./release.sh <version>` or trigger from CI with a version tag.
