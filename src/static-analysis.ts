/**
 * Lexical scrub utilities shared by the static-analysis tools.
 *
 * Static-analysis-by-regex has a recurring failure mode: a pattern matches
 * text inside a comment or string literal. `code.includes("eval(")` matches
 * `// avoid eval()`, and `/eval\s*\(/` matches `"don't use eval()"`. Each
 * tool can dodge that on its own, but the cleanest fix is one shared
 * pre-scrub so every tool inherits the same behavior.
 *
 * These are intentionally lexical, not full JS parsers. They handle the
 * common cases (//, slash-star ... star-slash, '...', "...", `...`) and
 * skip escapes. They do NOT distinguish a regex literal from a division,
 * because that requires tracking the prior token. In practice, regex
 * literals in user-supplied Electron code are rare in the contexts we
 * scan, so the residual false-positive risk is very low.
 */

const SQ = "'";
const DQ = '"';
const BT = "`";

function isQuote(c: string): boolean {
  return c === SQ || c === DQ || c === BT;
}

/**
 * Remove `//` and slash-star comments while leaving string literals intact.
 *
 * Use this when a check needs the contents of strings (for example, to find
 * a module name inside `import "core-js"` or a URL inside a `loadURL` call)
 * but should ignore the same text appearing in a comment.
 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];
    const next = i + 1 < n ? code[i + 1] : "";

    if (isQuote(c)) {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (code[i] === "\\" && i + 1 < n) {
          out += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += code[i];
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n - 1 && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * Remove comments AND the contents of string literals (preserving the quote
 * characters and any newlines inside the original string so line numbers
 * stay roughly aligned).
 *
 * Use this when a check is looking for a code construct (`eval(`, a function
 * call, a regex pattern) and the text appearing inside a string is not a
 * real call site -- it's documentation, an error message, or a regex source.
 *
 * Limitation: template-literal interpolations (`${expr}`) are treated as
 * string content and stripped along with the rest of the template body.
 * If you embed `eval()` inside `${ ... }`, this scan won't flag it. This
 * is a documented tradeoff in favor of a simpler, dependency-free scrub.
 */
export function stripCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];
    const next = i + 1 < n ? code[i + 1] : "";

    if (isQuote(c)) {
      const quote = c;
      out += quote;
      i++;
      while (i < n) {
        if (code[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        if (code[i] === "\n") out += "\n";
        i++;
      }
      out += quote;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n - 1 && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
