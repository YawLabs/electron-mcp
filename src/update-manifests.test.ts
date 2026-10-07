import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description (and
// homepage, version, license) into Ruby double-quoted strings in the Homebrew
// formula. These tests pin the escaping that keeps each value a plain string
// (CodeQL js/incomplete-sanitization). The file sits one level below the repo
// root in both layouts -- src/ and the compiled dist/ -- so the same hop works.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "update-manifests.mjs");

type Meta = Record<string, unknown>;
type HashFor = (asset: string) => string;
interface ManifestModule {
  rubyString: (value: unknown) => string;
  deriveMeta: (pkg: Record<string, unknown>, version: string) => Meta;
  renderFormula: (meta: Meta, hashFor: HashFor) => string;
  renderScoopManifest: (meta: Meta, hashFor: HashFor) => Record<string, unknown>;
}

let mod: ManifestModule;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs. Importing
  // it must not run the release: main() is gated on direct execution.
  mod = (await import(pathToFileURL(scriptPath).href)) as ManifestModule;
});

const fakeHash: HashFor = (asset) => `sha-of-${asset}`;

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early, interpolate code, or break the line.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

// Pull the literal body out of a `<key> "..."` line of the rendered formula.
function stanza(formula: string, key: string): string {
  const line = formula.split("\n").find((l) => l.startsWith(`  ${key} "`));
  assert.ok(line, `formula has no ${key} line:\n${formula}`);
  assert.ok(line.endsWith('"'), `${key} line does not end in a quote: ${line}`);
  return line.slice(`  ${key} "`.length, -1);
}

describe("update-manifests rubyString", () => {
  const cases = [
    "Electron MCP server: IPC scaffolding, security audits, CSP and fuses config",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "C# support, issue #12",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(mod.rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(mod.rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it starts an interpolation", () => {
    // `\#` before anything else is a redundant escape that `brew style` flags.
    assert.equal(mod.rubyString("C# and #1"), "C# and #1");
    assert.equal(mod.rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(mod.rubyString(undefined), "");
    assert.equal(mod.rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  const hostile = 'Evil \\" #{system("id")}\nline two';
  const hostilePkg = {
    name: "@yawlabs/electron-mcp",
    description: hostile,
    license: 'MIT" + `id` + "',
    homepage: "https://example.com/#{x}",
    bin: { "electron-mcp": "bin/electron-mcp.mjs" },
    repository: { url: "git+https://github.com/YawLabs/electron-mcp.git" },
  };

  it("routes desc, homepage, version and license through rubyString", () => {
    const formula = mod.renderFormula(mod.deriveMeta(hostilePkg, '1.0.0"#{x}'), fakeHash);
    assert.equal(parseRubyDq(stanza(formula, "desc")), hostile);
    assert.equal(parseRubyDq(stanza(formula, "homepage")), hostilePkg.homepage);
    assert.equal(parseRubyDq(stanza(formula, "version")), '1.0.0"#{x}');
    assert.equal(parseRubyDq(stanza(formula, "license")), hostilePkg.license);
    // The hostile newline stays inside the desc literal: the next line of the
    // formula is still the homepage stanza.
    const lines = formula.split("\n");
    assert.match(lines[1], /^ {2}desc "/);
    assert.match(lines[2], /^ {2}homepage "/);
  });

  it("escapes the urls and sha256s, which carry the --version tag and downloaded sidecar text", () => {
    const hostileVersion = '1.0.0"#{system("id")}';
    const hostileSha = '00"\nend\nclass Evil < Formula\n#{`id`}';
    const formula = mod.renderFormula(mod.deriveMeta(hostilePkg, hostileVersion), () => hostileSha);
    const urls = formula.split("\n").filter((l) => /^ +url "/.test(l));
    const shas = formula.split("\n").filter((l) => /^ +sha256 "/.test(l));
    assert.equal(urls.length, 3);
    assert.equal(shas.length, 3);
    for (const l of urls) {
      const body = l
        .trim()
        .replace(/^url "/, "")
        .replace(/", using: :nounzip$/, "");
      assert.match(parseRubyDq(body), /\/releases\/download\/v1\.0\.0"#\{system\("id"\)\}\//);
    }
    for (const l of shas)
      assert.equal(
        parseRubyDq(
          l
            .trim()
            .replace(/^sha256 "/, "")
            .replace(/"$/, ""),
        ),
        hostileSha,
      );
    assert.doesNotMatch(formula, /^class Evil/m);
  });

  it("escapes the command name in bin.install and the test block", () => {
    const meta = { ...mod.deriveMeta(hostilePkg, "1.0.0"), cmd: 'electron"#{x}' };
    const formula = mod.renderFormula(meta, fakeHash);
    assert.ok(formula.includes('bin.install Dir["*"].first => "electron\\"\\#{x}"'));
    assert.ok(formula.includes('shell_output("#{bin}/electron\\"\\#{x} --version")'));
  });

  for (const className of ["electronMcp", "2fa", "Foo.Bar", "Evil < Object; end; class X", ""]) {
    it(`refuses ${JSON.stringify(className)} as a class name`, () => {
      const meta = { ...mod.deriveMeta(hostilePkg, "1.0.0"), className };
      assert.throws(() => mod.renderFormula(meta, fakeHash), /class name/);
    });
  }

  it("renders the real package.json with no escaping needed", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as Record<string, unknown>;
    const formula = mod.renderFormula(mod.deriveMeta(pkg, String(pkg.version)), fakeHash);
    assert.equal(stanza(formula, "desc"), pkg.description);
    assert.match(formula, /^class ElectronMcp < Formula\n/);
    assert.match(formula, / {2}license "MIT"\n/);
  });

  it("serializes the Scoop manifest with JSON.stringify, so hostile values stay data", () => {
    const manifest = mod.renderScoopManifest(mod.deriveMeta(hostilePkg, "1.0.0"), fakeHash);
    const parsed = JSON.parse(JSON.stringify(manifest, null, 2)) as Record<string, unknown>;
    assert.equal(parsed.description, hostile);
    assert.deepEqual(parsed.license, { identifier: hostilePkg.license, url: "https://yaw.sh" });
  });
});
