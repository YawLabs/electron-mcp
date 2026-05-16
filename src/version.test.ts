import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveVersion, resolveVersionFromPackageJson } from "./version.js";

describe("resolveVersionFromPackageJson", () => {
  it("reads the version from ../package.json relative to the given module URL", () => {
    // Regression: src/index.ts's tsc-path fallback was never exercised by
    // the integration test (which always runs the esbuild bundle where
    // __VERSION__ is defined). A path or filename refactor that broke the
    // relative `../package.json` lookup would have shipped silently.
    const got = resolveVersionFromPackageJson(import.meta.url);
    const expected = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
    ).version;
    assert.strictEqual(got, expected);
    assert.match(got, /^\d+\.\d+\.\d+/);
  });
});

describe("resolveVersion (tsc-path runtime)", () => {
  it("returns a semver string", () => {
    // From dist/version.test.js, `__VERSION__` is undefined and the fallback
    // executes -- exactly the path that runs when someone invokes the tsc
    // output directly (e.g., for local debugging) without going through the
    // esbuild bundle.
    const v = resolveVersion();
    assert.match(v, /^\d+\.\d+\.\d+/);
  });
});
