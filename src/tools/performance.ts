import { z } from "zod";
import { stripComments } from "../static-analysis.js";

// Escape user input for safe embedding in a RegExp source. The heavy-module
// list is hardcoded so the actual risk is low, but doing this once here
// keeps the call sites obvious.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const performanceTools = [
  {
    name: "electron_audit_performance",
    description:
      "Analyze Electron app code for 7 official performance anti-patterns: eager module loading, synchronous main-process operations, excessive BrowserWindows at startup, unnecessary polyfills, CDN-loaded assets, heavy preload scripts, and unbundled dependencies. Returns specific fixes.",
    annotations: {
      title: "Audit performance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      mainCode: z.string().max(500_000).optional().describe("Main process code to analyze"),
      rendererCode: z.string().max(500_000).optional().describe("Renderer process code to analyze"),
      preloadCode: z.string().max(500_000).optional().describe("Preload script code to analyze"),
      packageJson: z
        .string()
        .max(500_000)
        .optional()
        .describe("package.json content to check for bundling and dependencies"),
    }),
    handler: async (input: {
      mainCode?: string;
      rendererCode?: string;
      preloadCode?: string;
      packageJson?: string;
    }) => {
      const findings: Array<{ pattern: string; severity: string; detail: string; fix: string }> = [];

      if (input.mainCode) {
        // Strip comments so a docstring that mentions `require("sharp")`
        // or `fs.readFileSync(...)` doesn't fire a finding. String contents
        // are preserved because the heavy-module check needs to see the
        // module name inside the import string.
        const code = stripComments(input.mainCode);

        // 1. Eager module loading -- top-level require/import of heavy
        // modules. The previous regex matched ANY occurrence of
        // require("sharp") or from "sharp", which incorrectly flagged
        // function-scoped lazy `require("sharp")` (the recommended
        // workaround). Anchor to start-of-line so only module-scope
        // declarations match: `import ... from "sharp"` (always
        // module-scope in JS) or a top-level `const|let|var ... =
        // require("sharp")`. Function-scoped requires are correctly
        // skipped because they aren't at line start.
        const heavyModules = [
          "sharp",
          "sqlite3",
          "better-sqlite3",
          "canvas",
          "@napi-rs/canvas",
          "node-canvas-prebuilt",
          "puppeteer",
          "playwright",
          "ffmpeg",
          "jimp",
          "onnxruntime-node",
          "@tensorflow/tfjs-node",
        ];
        for (const mod of heavyModules) {
          const m = escapeRegex(mod);
          // Anchor to column 0: top-level statements are at column 0 in
          // virtually all production JS. Indented `require("sharp")` lives
          // inside a function and is the recommended lazy-load pattern, so
          // it must NOT match. ES `import` is parser-restricted to module
          // scope so the equivalent constraint is automatic for it.
          const eagerPattern = new RegExp(
            `(?:^|\\n)import\\s[^;\\n]*from\\s+['"]${m}['"]` +
              `|(?:^|\\n)(?:export\\s+)?(?:const|let|var)\\s+[^=\\n]*=\\s*require\\s*\\(\\s*['"]${m}['"]`,
            "m",
          );
          if (eagerPattern.test(code)) {
            findings.push({
              pattern: `Eager loading of heavy module: ${mod}`,
              severity: "MEDIUM",
              detail: `'${mod}' is imported at the top level. Heavy modules delay app startup because they're loaded before the window is created. Each require() on Windows is especially slow due to NTFS.`,
              fix: `Lazy-load the module inside the function that needs it:\n\`\`\`typescript\n// Before (slow startup)\nimport sharp from "sharp";\n\n// After (fast startup)\nasync function processImage() {\n  const sharp = await import("sharp");\n  // use sharp...\n}\n\`\`\``,
            });
          }
        }

        // 2. Synchronous operations on main thread. Collect ALL matched
        // patterns and emit a single finding listing them; the previous
        // implementation broke after the first match and lost granularity.
        const syncPatterns: Array<{ pattern: RegExp; name: string }> = [
          {
            pattern: /fs\.readFileSync|fs\.writeFileSync|fs\.mkdirSync|fs\.readdirSync/,
            name: "fs *Sync calls",
          },
          { pattern: /\bexecSync\b|\bspawnSync\b/, name: "child_process *Sync" },
        ];
        const matchedSync = syncPatterns.filter((sp) => sp.pattern.test(code)).map((sp) => sp.name);
        if (matchedSync.length > 0) {
          findings.push({
            pattern: `Synchronous main-process operations: ${matchedSync.join(", ")}`,
            severity: "MEDIUM",
            detail:
              "Synchronous operations on the main thread block ALL windows and IPC communication. The entire app freezes until the operation completes.",
            fix: `Replace with async equivalents:\n\`\`\`typescript\n// Before\nconst data = fs.readFileSync("file.txt", "utf-8");\n\n// After\nconst data = await fs.promises.readFile("file.txt", "utf-8");\n\`\`\`\n\nFor CPU-intensive work, use a utility process:\n\`\`\`typescript\nconst worker = utilityProcess.fork("heavy-work.js");\n\`\`\``,
          });
        }

        // 3. Multiple BrowserWindows at startup
        const bwCount = (code.match(/new\s+BrowserWindow\s*\(/g) || []).length;
        if (bwCount > 2) {
          findings.push({
            pattern: `${bwCount} BrowserWindow instances created`,
            severity: "MEDIUM",
            detail: `Each BrowserWindow adds 150-250MB of memory. ${bwCount} windows at startup means ${bwCount * 200}MB+ just for empty windows.`,
            fix: "Create windows lazily -- only when the user requests them. Consider using tabs or views instead of separate windows.",
          });
        }
      }

      if (input.rendererCode) {
        // Strip comments only -- the polyfill check needs to see the
        // module name inside the import string literal.
        const code = stripComments(input.rendererCode);

        // 4. Unnecessary polyfills. Match an actual import or require of
        // the package, not a bare substring. The previous `code.includes`
        // scan flagged comments like "// core-js is bad" and any incidental
        // mention.
        const polyfills = [
          "core-js",
          "@babel/polyfill",
          "regenerator-runtime",
          "whatwg-fetch",
          "promise-polyfill",
          "unfetch",
        ];
        for (const poly of polyfills) {
          const p = escapeRegex(poly);
          // Match `import "core-js"`, `import "core-js/stable"`,
          // `import x from "core-js"`, `require("core-js")`,
          // `require("core-js/stable")`. Allow `/` after the name so
          // sub-path imports (`core-js/stable`) still match, and require
          // a closing quote or path separator so `core-js-not-this-one`
          // doesn't match.
          const importRe = new RegExp(`(?:require\\s*\\(\\s*|from\\s+|import\\s+)['"]${p}(?:['"]|\\/)`, "");
          if (importRe.test(code)) {
            findings.push({
              pattern: `Unnecessary polyfill: ${poly}`,
              severity: "LOW",
              detail: `'${poly}' polyfills web APIs that Electron's Chromium already supports natively. Polyfills add bundle size and startup time for no benefit in Electron.`,
              fix: `Remove the polyfill. Electron's Chromium supports: Promise, async/await, fetch, Array.from, Object.assign, Map, Set, Symbol, WeakMap, and all modern JS features. Remove '${poly}' from your dependencies.`,
            });
          }
        }

        // 5. CDN-loaded resources
        if (/https?:\/\/(?:cdn|unpkg|jsdelivr|cdnjs)\b/.test(code)) {
          findings.push({
            pattern: "CDN-loaded resources",
            severity: "MEDIUM",
            detail:
              "Loading resources from CDNs adds network latency to an app that has all resources available locally. It also fails when offline.",
            fix: "Bundle all assets locally. Install libraries via npm and import them in your bundler. For fonts, download and include them in your assets directory.",
          });
        }
      }

      if (input.preloadCode) {
        const code = stripComments(input.preloadCode);

        // 6. Heavy preload
        const importCount = (code.match(/import\s+|require\s*\(/g) || []).length;
        if (importCount > 10) {
          findings.push({
            pattern: `Heavy preload script (${importCount} imports)`,
            severity: "MEDIUM",
            detail:
              "The preload script loads before the page content is visible. Too many imports in preload delay the first paint.",
            fix: "Keep the preload minimal -- only contextBridge setup and IPC wrappers. Move logic to the main process or renderer.",
          });
        }
      }

      if (input.packageJson) {
        // 7. Unbundled code check
        try {
          const pkg = JSON.parse(input.packageJson);
          const depCount = Object.keys(pkg.dependencies || {}).length;
          if (
            depCount > 20 &&
            !pkg.devDependencies?.["electron-vite"] &&
            !pkg.devDependencies?.esbuild &&
            !pkg.devDependencies?.webpack &&
            !pkg.devDependencies?.vite &&
            !pkg.devDependencies?.["@electron-forge/plugin-vite"] &&
            !pkg.devDependencies?.["@electron-forge/plugin-webpack"] &&
            !pkg.devDependencies?.rollup &&
            !pkg.devDependencies?.parcel
          ) {
            findings.push({
              pattern: `${depCount} runtime dependencies without apparent bundler`,
              severity: "MEDIUM",
              detail:
                "Many runtime dependencies without a bundler means Node.js resolves and loads each module individually at startup. On Windows with NTFS, each require() can take 5-20ms.",
              fix: "Use a bundler (electron-vite, esbuild, webpack) to bundle your main and preload code into single files. This dramatically improves startup time.",
            });
          }
        } catch {
          // Skip if JSON is invalid
        }
      }

      if (!input.mainCode && !input.rendererCode && !input.preloadCode && !input.packageJson) {
        return "Please provide at least one of: mainCode, rendererCode, preloadCode, or packageJson to analyze.";
      }

      if (findings.length === 0) {
        return "# Performance Audit: CLEAN\n\nNo performance anti-patterns detected. Note: this is a static analysis -- profile your app with Chrome DevTools (View > Toggle Developer Tools) for runtime performance data.";
      }

      let report = `# Performance Audit: ${findings.length} FINDING(S)\n\n`;

      for (const [i, f] of findings.entries()) {
        report += `## ${i + 1}. [${f.severity}] ${f.pattern}\n\n${f.detail}\n\n### Fix\n\n${f.fix}\n\n---\n\n`;
      }

      report += `## General Performance Tips

1. **Measure first**: Use \`process.getCreationTime()\` and \`performance.now()\` to find actual bottlenecks
2. **Lazy-load everything**: Don't import modules until they're needed
3. **Use utility processes**: For CPU-intensive work, spawn a utility process
4. **Profile with DevTools**: Chrome DevTools Performance tab works in Electron
5. **Monitor memory**: \`process.memoryUsage()\` and DevTools Memory tab`;

      return report;
    },
  },
] as const;
