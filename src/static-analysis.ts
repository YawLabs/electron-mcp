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

/**
 * A `shell.openExternal(arg)` call is considered "safe" iff its first argument
 * is a complete string literal that starts with `https://`. Anything else
 * (variable, concatenation, non-https protocol, template literal with a
 * `${...}` interpolation, plain http) means the URL might originate from
 * user input and warrants validation.
 *
 * The three alternates cover single-quoted, double-quoted, and backtick
 * literals. Backtick bodies are accepted ONLY when they contain no `${`
 * interpolation; a literal `` `https://example.com` `` is safe, but a
 * `` `https://example.com/${userInput}` `` is not.
 */
const SAFE_HTTPS_LITERAL_NO_INTERP = /^(?:'https:\/\/[^']*'|"https:\/\/[^"]*"|`https:\/\/(?:[^`$]|\$(?!\{))*`)\s*$/;

/**
 * Skip over a string/template literal. `start` points AT the opening quote;
 * returns the index of the matching closing quote (or the last index of the
 * input for an unterminated literal). Escapes (`\"`, `` \` ``) are honored.
 */
function skipString(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2;
      continue;
    }
    if (code[i] === quote) return i;
    i++;
  }
  return code.length - 1;
}

/**
 * Read the first argument expression starting at `start`, stopping at a
 * top-level comma or the call's closing paren. String/template literals and
 * nested brackets are treated as opaque, so a `)` or `,` *inside* a URL
 * literal (e.g. `"https://en.wikipedia.org/wiki/Foo_(bar)"`) does not
 * prematurely terminate the argument.
 */
function readFirstArg(code: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < code.length; i++) {
    const c = code[i];
    if (isQuote(c)) {
      i = skipString(code, i, c);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (c === "]" || c === "}") {
      depth--;
    } else if (c === "," && depth === 0) {
      break;
    }
  }
  return code.slice(start, i);
}

/**
 * Return the first argument of every `shell.openExternal(arg)` call that is
 * NOT a hardcoded safe https string literal.
 *
 * Unlike a `[^,)]+` capture, this walks the real argument boundary while
 * skipping over string literals, so a hardcoded `https://...(...)...` URL
 * containing a `)` or `,` is read whole and recognized as safe instead of
 * being truncated into an unterminated literal and falsely flagged.
 *
 * Callers should pass code that has already been run through `stripComments`
 * so that mentions of `shell.openExternal` inside comments don't fire.
 */
export function unsafeOpenExternalCallSites(code: string): string[] {
  const unsafe: string[] = [];
  const callRe = /shell\.openExternal\s*\(\s*/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = callRe.exec(code)) !== null) {
    const arg = readFirstArg(code, callRe.lastIndex).trim();
    if (arg.length > 0 && !SAFE_HTTPS_LITERAL_NO_INTERP.test(arg)) {
      unsafe.push(arg);
    }
    // Advance past the argument we just read so a literal that itself
    // contains `shell.openExternal(` can't cause a re-scan loop.
    callRe.lastIndex += Math.max(arg.length, 1);
  }
  return unsafe;
}

export function hasUnsafeOpenExternal(code: string): boolean {
  return unsafeOpenExternalCallSites(code).length > 0;
}

/**
 * Index just past the `)` matching the `(` at `open`. String literals are
 * skipped so a quote inside the call can't throw off the depth count. Returns
 * `code.length` if the parens are unbalanced.
 */
function matchingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (isQuote(c)) {
      i = skipString(code, i, c);
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/**
 * A bare `ipcRenderer` value (or bare method reference like `ipcRenderer.send`)
 * exposed as an object member -- i.e. terminated by `,`, `}`, or end-of-input
 * rather than a `(` call. `ipcRenderer.invoke(...)` inside a wrapper closure
 * is NOT matched because `(` is not in the terminator set.
 */
const RAW_IPC_RENDERER_RE =
  /\bipcRenderer(?:\.(?:send|invoke|on|once|sendSync|postMessage|sendTo|sendToHost|removeListener|removeAllListeners))?\s*(?:[,}]|$)/;

/**
 * Detect whether any `contextBridge.exposeInMainWorld(...)` call exposes raw
 * `ipcRenderer` (the whole object or a bare method reference) to the renderer.
 *
 * Scans ONLY the balanced-paren argument region of each call -- a previous
 * single-regex form used an unbounded `[\s\S]*?` gap that spanned from the
 * first `exposeInMainWorld` to ANY later bare `ipcRenderer` token in the file,
 * so a safe wrapped bridge followed by an unrelated `const { ipcRenderer } =
 * require("electron")` (or even a string mentioning "ipcRenderer,") was
 * reported as a CRITICAL false positive. String contents inside the argument
 * are stripped before the test so a documentation string can't trip it.
 *
 * Callers should pass code that has already been run through `stripComments`.
 */
export function exposesRawIpcRenderer(code: string): boolean {
  const callRe = /contextBridge\s*\.\s*exposeInMainWorld\s*\(/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = callRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1; // index of the "("
    const end = matchingParen(code, open);
    const args = stripCommentsAndStrings(code.slice(open, end));
    if (RAW_IPC_RENDERER_RE.test(args)) return true;
    callRe.lastIndex = end;
  }
  return false;
}
