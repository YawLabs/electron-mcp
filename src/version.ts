import { createRequire } from "node:module";

// Injected at build time by esbuild. Undefined in tsc-only builds (and in
// test files compiled by tsc alone), where the fallback below kicks in.
declare const __VERSION__: string | undefined;

/**
 * Resolve the package version.
 *
 * In bundled builds (esbuild), `__VERSION__` is substituted with a string
 * literal and this returns it directly. In tsc-only builds (where esbuild's
 * `define` doesn't run), the fallback reads `../package.json` relative to
 * this module's file URL.
 */
export function resolveVersion(): string {
  if (typeof __VERSION__ !== "undefined") return __VERSION__;
  return resolveVersionFromPackageJson(import.meta.url);
}

/**
 * Tsc-path fallback exposed for tests. The runtime test suite always loads
 * tsc output (`dist/version.js`), where `__VERSION__` is undefined and
 * `resolveVersion()` falls into this branch anyway -- but calling this
 * helper directly lets the test bypass the `__VERSION__` check entirely so
 * the fallback stays under test even after future build changes.
 */
export function resolveVersionFromPackageJson(metaUrl: string): string {
  const pkg = createRequire(metaUrl)("../package.json") as { version: string };
  return pkg.version;
}
