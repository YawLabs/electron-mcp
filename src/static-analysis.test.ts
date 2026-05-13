import assert from "node:assert";
import { describe, it } from "node:test";
import {
  hasUnsafeOpenExternal,
  stripComments,
  stripCommentsAndStrings,
  unsafeOpenExternalCallSites,
} from "./static-analysis.js";

describe("stripComments", () => {
  it("removes line comments while preserving code on the same line", () => {
    const out = stripComments("const x = 1; // this is a comment\nconst y = 2;");
    assert.ok(out.includes("const x = 1;"));
    assert.ok(out.includes("const y = 2;"));
    assert.ok(!out.includes("this is a comment"));
  });

  it("removes block comments spanning multiple lines", () => {
    const out = stripComments("before /* comment\nstill comment */ after");
    assert.ok(out.includes("before"));
    assert.ok(out.includes("after"));
    assert.ok(!out.includes("comment"));
  });

  it("does NOT treat // inside a string as a comment start", () => {
    const out = stripComments(`const url = "https://example.com/path";`);
    assert.ok(out.includes("https://example.com/path"), `string content must be preserved; got: ${out}`);
  });

  it("does NOT treat slash-star inside a string as a block comment start", () => {
    const out = stripComments(`const re = "/* not a comment */";`);
    assert.ok(out.includes("/* not a comment */"), `string content must be preserved; got: ${out}`);
  });

  it("preserves escapes inside strings (no premature termination)", () => {
    const out = stripComments(`const x = "she said \\"hi\\""; // c`);
    assert.ok(out.includes(`"she said \\"hi\\""`));
    assert.ok(!out.includes("// c"));
  });

  it("preserves template literals verbatim", () => {
    const out = stripComments("const x = `hello ${name}`; // c");
    assert.ok(out.includes("`hello ${name}`"));
    assert.ok(!out.includes("// c"));
  });

  it("handles unterminated block comments without infinite-looping", () => {
    // No trailing slash-star-slash. Should consume to end of input and return.
    const out = stripComments("before /* never closes");
    assert.strictEqual(typeof out, "string");
    assert.ok(out.startsWith("before"));
  });
});

describe("stripCommentsAndStrings", () => {
  it("strips both line/block comments and string contents", () => {
    const out = stripCommentsAndStrings(`const url = "https://example.com"; // c`);
    assert.ok(!out.includes("https://example.com"));
    assert.ok(!out.includes("// c"));
    // Quote characters themselves are preserved so structural regexes still fire.
    assert.ok(out.includes('""'));
  });

  it("strips eval() that lives inside a string literal", () => {
    const out = stripCommentsAndStrings(`const help = "Don't use eval() unless you know what you're doing";`);
    assert.ok(!/eval\s*\(/.test(out), `eval inside a string must not survive the scrub; got: ${out}`);
  });

  it("strips eval() that lives inside a comment", () => {
    const out = stripCommentsAndStrings("// avoid eval() please\nconst x = 1;");
    assert.ok(!/eval\s*\(/.test(out));
    assert.ok(out.includes("const x = 1;"));
  });

  it("preserves real eval() calls in code", () => {
    const out = stripCommentsAndStrings("function run(input) { return eval(input); }");
    assert.ok(/eval\s*\(/.test(out), `real eval call must remain; got: ${out}`);
  });

  it("preserves newlines inside stripped strings so line numbers stay aligned", () => {
    const before = 'const x = "line1\nline2\nline3";';
    const out = stripCommentsAndStrings(before);
    const newlines = out.match(/\n/g)?.length ?? 0;
    assert.strictEqual(newlines, 2, `expected 2 preserved newlines from the multiline string; got ${newlines}`);
  });

  it("handles backtick template literals", () => {
    const out = stripCommentsAndStrings("const x = `hello world`;");
    assert.ok(out.includes("``"));
    assert.ok(!out.includes("hello world"));
  });
});

describe("unsafeOpenExternalCallSites", () => {
  it("treats hardcoded https double-quoted literals as safe", () => {
    const out = unsafeOpenExternalCallSites(`shell.openExternal("https://example.com");`);
    assert.strictEqual(out.length, 0);
  });

  it("treats hardcoded https single-quoted literals as safe", () => {
    const out = unsafeOpenExternalCallSites(`shell.openExternal('https://example.com/docs');`);
    assert.strictEqual(out.length, 0);
  });

  it("treats interpolation-free template literals as safe", () => {
    const out = unsafeOpenExternalCallSites("shell.openExternal(`https://example.com/docs`);");
    assert.strictEqual(out.length, 0);
  });

  it("flags template literals that contain ${} interpolations", () => {
    // Regression: the old regex `[^'"\`]*` allowed `$`, `{`, `}` in the body,
    // so `\`https://example.com/${userInput}\`` matched the safe pattern and
    // never got flagged -- the exact "URL might come from user input" class
    // the audit is meant to catch.
    const out = unsafeOpenExternalCallSites("shell.openExternal(`https://example.com/${userInput}`);");
    assert.strictEqual(out.length, 1, "template literal with interpolation must be flagged");
  });

  it("flags non-https hardcoded literals", () => {
    const out = unsafeOpenExternalCallSites(`shell.openExternal("file:///etc/passwd");`);
    assert.strictEqual(out.length, 1);
  });

  it("flags bare-variable arguments", () => {
    const out = unsafeOpenExternalCallSites("shell.openExternal(url);");
    assert.strictEqual(out.length, 1);
  });

  it("flags concatenated string expressions", () => {
    const out = unsafeOpenExternalCallSites(`shell.openExternal("https://" + domain);`);
    assert.strictEqual(out.length, 1);
  });

  it("hasUnsafeOpenExternal mirrors unsafeOpenExternalCallSites().length > 0", () => {
    assert.strictEqual(hasUnsafeOpenExternal(`shell.openExternal("https://example.com");`), false);
    assert.strictEqual(hasUnsafeOpenExternal("shell.openExternal(url);"), true);
  });
});
