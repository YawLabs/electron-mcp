import { z } from "zod";

export const buildTools = [
  {
    name: "electron_diagnose_build_error",
    description:
      "Diagnose Electron build/packaging errors from electron-builder, electron-forge, or electron-packager output. Identifies common failures: code signing errors, native module rebuild issues, ASAR packaging problems, missing platform-specific configuration, and __dirname path resolution bugs.",
    annotations: {
      title: "Diagnose build error",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      errorOutput: z.string().max(500_000).describe("The build error output (stderr/stdout) to diagnose"),
      buildTool: z
        .enum(["electron-builder", "electron-forge", "electron-packager", "unknown"])
        .optional()
        .describe("Which build tool produced the error. Defaults to 'unknown' (auto-detect)."),
      platform: z
        .enum(["win32", "darwin", "linux", "unknown"])
        .optional()
        .describe("Target platform. Defaults to 'unknown' (auto-detect)."),
    }),
    handler: async (input: { errorOutput: string; buildTool?: string; platform?: string }) => {
      const output = input.errorOutput;
      const platform = input.platform ?? "unknown";
      const buildTool = input.buildTool ?? "unknown";
      // Scope checks by platform: "unknown" means fall back to detection from output.
      const includeMac = platform === "unknown" || platform === "darwin";
      const includeWin = platform === "unknown" || platform === "win32";
      const diagnoses: Array<{ problem: string; cause: string; fix: string }> = [];

      // Code signing errors
      if (/code\s*sign|codesign|sign.*fail|ERR_ELECTRON_BUILDER_CANNOT_EXECUTE|notarize|notarization/i.test(output)) {
        if (includeMac && /identity.*not\s*found|no\s*signing\s*identity|errSecInternalComponent/i.test(output)) {
          diagnoses.push({
            problem: "macOS code signing identity not found",
            cause:
              "The signing certificate is not installed in your Keychain, or the identity name doesn't match. This happens when building on CI without importing certificates.",
            fix: `1. List available identities: \`security find-identity -v -p codesigning\`
2. Set the identity in your config:
   \`\`\`json
   // electron-builder
   "mac": { "identity": "Developer ID Application: Your Name (TEAMID)" }
   \`\`\`
3. For CI: import the .p12 certificate into a temporary keychain before building.`,
          });
        }

        if (includeMac && /notariz|staple|altool|notarytool/i.test(output)) {
          diagnoses.push({
            problem: "macOS notarization failed",
            cause:
              "Apple notarization requires: (1) a valid Developer ID certificate, (2) hardened runtime enabled, (3) no unsigned nested code, (4) valid Apple ID credentials.",
            fix: `1. Enable hardened runtime in your forge/builder config:
   \`\`\`json
   "mac": {
     "hardenedRuntime": true,
     "gatekeeperAssess": false,
     "entitlements": "entitlements.plist",
     "entitlementsInherit": "entitlements.plist"
   }
   \`\`\`
2. Use notarytool (replaces altool):
   \`\`\`bash
   xcrun notarytool submit app.zip --apple-id "you@example.com" --team-id "TEAMID" --password "@keychain:AC_PASSWORD"
   \`\`\`
3. Check the notarization log for specific rejection reasons.`,
          });
        }

        if (includeWin && /signtool|windows.*sign|authenticode|Azure.*Sign/i.test(output)) {
          diagnoses.push({
            problem: "Windows code signing failed",
            cause:
              "Windows code signing requires a valid certificate (.pfx file or Azure Trusted Signing). Common issues: expired certificate, wrong password, missing signtool.exe.",
            fix: `1. For local .pfx signing, set environment variables:
   \`\`\`
   CSC_LINK=/path/to/cert.pfx
   CSC_KEY_PASSWORD=your-password
   \`\`\`
2. For Azure Trusted Signing, configure in electron-builder:
   \`\`\`json
   "win": {
     "azureSignOptions": {
       "endpoint": "https://eus.codesigning.azure.net",
       "certificateProfileName": "your-profile"
     }
   }
   \`\`\``,
          });
        }
      }

      // Native module rebuild errors
      if (
        /node-gyp|rebuild|native.*module|\.node.*file|prebuild|node-pre-gyp|electron-rebuild|@electron\/rebuild/i.test(
          output,
        )
      ) {
        if (/gyp ERR|node-gyp|MSBuild|visual\s*studio|python/i.test(output)) {
          diagnoses.push({
            problem: "Native module build tool missing",
            cause:
              "Native Node.js modules require compilation tools: Python 3, and a C++ compiler (Visual Studio Build Tools on Windows, Xcode on macOS, gcc on Linux).",
            fix: `1. Windows: Install Visual Studio Build Tools:
   \`\`\`bash
   npm install --global windows-build-tools
   # or install "Desktop development with C++" workload in Visual Studio
   \`\`\`
2. macOS: \`xcode-select --install\`
3. Linux: \`sudo apt install build-essential python3\`
4. Then rebuild: \`npx @electron/rebuild\``,
          });
        }

        if (/version.*mismatch|NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(output)) {
          diagnoses.push({
            problem: "Native module version mismatch",
            cause:
              "The native module was compiled for a different Node.js version than Electron's internal Node.js. This happens when you `npm install` with system Node.js but run in Electron.",
            fix: `Rebuild native modules against Electron's Node.js:
\`\`\`bash
npx @electron/rebuild
\`\`\`

Or in package.json:
\`\`\`json
{
  "scripts": {
    "postinstall": "electron-rebuild"
  }
}
\`\`\`

If using electron-builder, add:
\`\`\`json
"build": {
  "npmRebuild": true
}
\`\`\``,
          });
        }
      }

      // ASAR issues
      if (/asar|ENOENT.*app\.asar|cannot\s*find.*asar/i.test(output)) {
        diagnoses.push({
          problem: "ASAR packaging issue",
          cause:
            "Common ASAR issues: (1) Code uses __dirname which resolves to inside the ASAR archive, (2) native .node files can't be loaded from inside ASAR, (3) fs operations fail on paths inside ASAR.",
          fix: `1. For __dirname issues, use app.getAppPath() or app.isPackaged:
\`\`\`typescript
const basePath = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked")
  : __dirname;
\`\`\`

2. For native modules, unpack them from ASAR:
\`\`\`json
// electron-builder
"build": {
  "asarUnpack": ["**/*.node", "**/native-module/**"]
}

// electron-forge
"packagerConfig": {
  "asar": {
    "unpack": "**/*.node"
  }
}
\`\`\`

3. For file operations, use app.getPath() for writable directories:
\`\`\`typescript
const dataDir = app.getPath("userData"); // Writable
\`\`\``,
        });
      }

      // Missing resources -- require a packaging-specific signal so we don't
      // attribute a generic "npm install missed a devDep" MODULE_NOT_FOUND to
      // ASAR/extraResources. Signals cover macOS bundles (`.app/Contents`),
      // Linux/dev paths (`app.asar`, `resourcesPath`), Windows installer
      // paths (`AppData\Local`, `Program Files`, NSIS-style `app-X.Y.Z`),
      // and Squirrel-packaged Windows builds.
      const looksLikePackagingIssue =
        /app\.asar|resourcesPath|extraResources|extraFiles|app\.asar\.unpacked|\.app\/Contents|\\AppData\\Local\\|[\\/]Program Files[\\/]|[\\/]app-\d+\.\d+\.\d+[\\/]|squirrel/i.test(
          output,
        );
      if (
        looksLikePackagingIssue &&
        /ENOENT|file\s*not\s*found|cannot\s*find\s*module|MODULE_NOT_FOUND/i.test(output)
      ) {
        diagnoses.push({
          problem: "Missing file or module in packaged app",
          cause:
            "Files present during development but missing after packaging. Common causes: (1) files not included in the ASAR, (2) dynamic require() with variable paths, (3) assets referenced by __dirname that need extraResources.",
          fix: `1. Add files to extraResources (outside ASAR, copied as-is):
\`\`\`json
// electron-builder
"build": {
  "extraResources": [
    { "from": "assets/", "to": "assets/" }
  ]
}
\`\`\`

2. Add files to extraFiles (at the app root):
\`\`\`json
"build": {
  "extraFiles": [
    { "from": "config/", "to": "config/" }
  ]
}
\`\`\`

3. Access with process.resourcesPath:
\`\`\`typescript
const assetPath = path.join(process.resourcesPath, "assets", "file.txt");
\`\`\``,
        });
      }

      // Permission errors
      if (/EPERM|EACCES|permission\s*denied/i.test(output)) {
        diagnoses.push({
          problem: "Permission denied during build",
          cause:
            "The build process can't write to the output directory, or a file is locked by another process (common on Windows when the app is still running).",
          fix: `1. Close any running instances of your Electron app
2. On Windows, check if the dist/ folder is open in Explorer
3. Try running the build with elevated permissions
4. Delete the dist/ and out/ folders manually, then rebuild`,
        });
      }

      // Icon errors
      if (/icon.*not\s*found|icon.*invalid|\.ico|\.icns|\.png.*icon/i.test(output)) {
        diagnoses.push({
          problem: "App icon error",
          cause:
            "Missing or invalid app icon. Each platform requires a specific format: .ico (Windows, 256x256), .icns (macOS), .png (Linux, 512x512).",
          fix: `Provide icons for each platform:
\`\`\`json
// electron-builder
"build": {
  "win": { "icon": "assets/icon.ico" },
  "mac": { "icon": "assets/icon.icns" },
  "linux": { "icon": "assets/icon.png" }
}
\`\`\`

electron-builder can auto-convert from a 512x512+ PNG if you only provide one format.`,
        });
      }

      if (diagnoses.length === 0) {
        // Generic analysis
        diagnoses.push({
          problem: "Unrecognized build error",
          cause: "The error pattern doesn't match common Electron build failures.",
          fix: `General troubleshooting steps:
1. Delete node_modules, package-lock.json, dist/, out/ and reinstall: \`rm -rf node_modules dist out && npm install\`
2. Ensure your Electron version matches your build tool's supported range
3. Check the build tool's GitHub issues for your specific error message
4. Try building with verbose logging:
   - electron-builder: \`DEBUG=electron-builder npm run build\`
   - electron-forge: \`DEBUG=* npx electron-forge make\``,
        });
      }

      let report = "# Build Error Diagnosis\n\n";
      if (platform !== "unknown" || buildTool !== "unknown") {
        const scope: string[] = [];
        if (platform !== "unknown") scope.push(`platform: **${platform}**`);
        if (buildTool !== "unknown") scope.push(`build tool: **${buildTool}**`);
        report += `_Scoped to ${scope.join(", ")}. Platform-specific diagnoses from other platforms are suppressed._\n\n`;
      }
      for (const [i, d] of diagnoses.entries()) {
        report += `## ${i + 1}. ${d.problem}\n\n**Cause:** ${d.cause}\n\n**Fix:**\n\n${d.fix}\n\n`;
      }

      return report;
    },
  },

  {
    name: "electron_configure_auto_update",
    description:
      "Generate complete auto-update configuration using electron-updater. Produces main process setup, update event handling, renderer notification UI code, and platform-specific signing requirements. Supports GitHub releases, S3, and generic HTTP update servers.",
    annotations: {
      title: "Configure auto-update",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      provider: z
        .enum(["github", "s3", "generic"])
        .describe("Update distribution method: 'github' (GitHub Releases), 's3' (AWS S3), 'generic' (any HTTP server)"),
      githubOwner: z.string().optional().describe("GitHub owner (for 'github' provider)"),
      githubRepo: z.string().optional().describe("GitHub repo name (for 'github' provider)"),
      s3Bucket: z.string().optional().describe("S3 bucket name (for 's3' provider)"),
      genericUrl: z.string().optional().describe("Base URL for updates (for 'generic' provider)"),
      autoDownload: z.boolean().optional().describe("Automatically download updates (default true)"),
      autoInstallOnQuit: z.boolean().optional().describe("Install update on app quit (default true)"),
    }),
    handler: async (input: {
      provider: string;
      githubOwner?: string;
      githubRepo?: string;
      s3Bucket?: string;
      genericUrl?: string;
      autoDownload?: boolean;
      autoInstallOnQuit?: boolean;
    }) => {
      let publishConfig: string;
      if (input.provider === "github") {
        publishConfig = `  "publish": {
    "provider": "github",
    "owner": "${input.githubOwner || "your-github-username"}",
    "repo": "${input.githubRepo || "your-repo-name"}"
  }`;
      } else if (input.provider === "s3") {
        publishConfig = `  "publish": {
    "provider": "s3",
    "bucket": "${input.s3Bucket || "your-bucket-name"}"
  }`;
      } else {
        publishConfig = `  "publish": {
    "provider": "generic",
    "url": "${input.genericUrl || "https://updates.example.com"}"
  }`;
      }

      const autoDownload = input.autoDownload !== false;
      const autoInstall = input.autoInstallOnQuit !== false;

      const mainCode = `// src/main/updater.ts
import { autoUpdater } from "electron-updater";
import { BrowserWindow, ipcMain } from "electron";
import log from "electron-log";

// Route autoUpdater logs through electron-log
autoUpdater.logger = log;

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = ${autoDownload};
  autoUpdater.autoInstallOnAppQuit = ${autoInstall};

  // ── Update events ──

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates...");
    mainWindow.webContents.send("update-status", { status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info.version);
    mainWindow.webContents.send("update-status", {
      status: "available",
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("update-not-available", () => {
    log.info("App is up to date");
    mainWindow.webContents.send("update-status", { status: "up-to-date" });
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow.webContents.send("update-status", {
      status: "downloading",
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info.version);
    mainWindow.webContents.send("update-status", {
      status: "downloaded",
      version: info.version,
    });
  });

  autoUpdater.on("error", (error) => {
    log.error("Update error:", error);
    mainWindow.webContents.send("update-status", {
      status: "error",
      message: error.message,
    });
  });

  // ── IPC handlers ──
${
  autoDownload
    ? ""
    : `
  ipcMain.handle("update-download", () => {
    return autoUpdater.downloadUpdate();
  });
`
}
  ipcMain.handle("update-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("update-check", () => {
    return autoUpdater.checkForUpdates();
  });

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error("Update check failed:", err);
    });
  }, 3000);
}`;

      const preloadCode = `// Add to your preload.ts contextBridge
{
  // Auto-update
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },
  checkForUpdates: () => ipcRenderer.invoke("update-check"),${autoDownload ? "" : '\n  downloadUpdate: () => ipcRenderer.invoke("update-download"),'}
  installUpdate: () => ipcRenderer.invoke("update-install"),
}

// Type for update status
interface UpdateStatus {
  status: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
  version?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  message?: string;
}`;

      const builderConfig = `// In your electron-builder config (electron-builder.yml or package.json "build" section)
{
${publishConfig},
  "win": {
    "target": ["nsis"],
    "publisherName": ["Your Company Name"]
  },
  "mac": {
    "target": ["dmg", "zip"],
    "hardenedRuntime": true,
    "notarize": true
  },
  "linux": {
    "target": ["AppImage", "deb"]
  }
}`;

      const sections = [
        `# Auto-Update Configuration (${input.provider})\n`,
        "## 1. Install dependencies\n\n```bash\nnpm install electron-updater electron-log\n```",
        `## 2. Main process updater\n\n\`\`\`typescript\n${mainCode}\n\`\`\``,
        `## 3. Preload bridge additions\n\n\`\`\`typescript\n${preloadCode}\n\`\`\``,
        `## 4. Build configuration\n\n\`\`\`json\n${builderConfig}\n\`\`\``,
        `## 5. Usage in main entry point\n\n\`\`\`typescript\nimport { initAutoUpdater } from "./updater.js";\n\napp.whenReady().then(() => {\n  const mainWindow = createMainWindow();\n  initAutoUpdater(mainWindow);\n});\n\`\`\``,
        `## Platform-specific requirements

### Windows
- Code signing is **required** for auto-update (unsigned apps will show SmartScreen warnings)
- NSIS target is recommended (squirrel is deprecated)
- Set \`publisherName\` to match your code signing certificate

### macOS
- Code signing + notarization are **required**
- Must include a ZIP target (DMG alone won't work for auto-update)
- Hardened runtime must be enabled

### Linux
- AppImage format supports auto-update
- Snap and Flatpak have their own update mechanisms
- No code signing required`,
      ];

      return sections.join("\n\n");
    },
  },

  {
    name: "electron_configure_deep_linking",
    description:
      "Generate complete custom protocol / deep linking setup for Electron. Produces protocol registration, URL handling in both single-instance and multi-instance modes, platform-specific configuration (macOS Info.plist, Windows registry, Linux .desktop), and electron-builder/forge config.",
    annotations: {
      title: "Configure deep linking",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      protocol: z.string().describe("Custom protocol scheme, e.g. 'myapp' (will handle myapp:// URLs)"),
      singleInstance: z
        .boolean()
        .optional()
        .describe("Enforce single instance -- new URLs focus the existing window (default true)"),
      routes: z
        .array(
          z.object({
            path: z.string().describe("URL path pattern, e.g. '/settings', '/file/*'"),
            description: z.string().describe("What this route does"),
          }),
        )
        .optional()
        .describe("Routes to handle within the protocol"),
    }),
    handler: async (input: {
      protocol: string;
      singleInstance?: boolean;
      routes?: Array<{ path: string; description: string }>;
    }) => {
      const proto = input.protocol.replace(/:\/\/.*$/, "").toLowerCase();
      const singleInstance = input.singleInstance !== false;

      const mainCode = `// src/main/deep-link.ts
import { app, BrowserWindow } from "electron";
import * as path from "node:path";

const PROTOCOL = "${proto}";

// Register as default handler for the protocol
if (process.defaultApp) {
  // During development, register with the full path to the script
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

${
  singleInstance
    ? `// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    // Windows/Linux: the URL is in the command line arguments
    const url = commandLine.find((arg) => arg.startsWith(\`\${PROTOCOL}://\`));
    if (url) {
      handleDeepLink(url);
    }

    // Focus the main window
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}`
    : ""
}

// macOS: handle open-url event
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

export function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== \`\${PROTOCOL}:\`) return;

    // myapp://settings           -> host="settings", pathname=""
    // myapp://settings/sub       -> host="settings", pathname="/sub"
    // myapp:settings             -> host="",         pathname="settings"
    // myapp:/settings            -> host="",         pathname="/settings"
    //
    // Normalize all four into a single leading-slash path so route matching
    // is consistent regardless of how the OS handed the URL to us.
    const rawPath = parsed.pathname || "";
    const host = parsed.host || "";
    const path = host
      ? \`/\${host}\${rawPath}\`
      : rawPath.startsWith("/")
        ? rawPath
        : \`/\${rawPath}\`;
    const params = Object.fromEntries(parsed.searchParams);

    console.log(\`Deep link: path=\${path}, params=\${JSON.stringify(params)}\`);

    // Route the deep link
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send("deep-link", { path, params, raw: url });
    }${
      input.routes
        ? `\n\n    // Handle specific routes\n    switch (true) {\n${input.routes.map((r) => `      case path.startsWith("${r.path.replace("/*", "")}"): // ${r.description}\n        break;`).join("\n")}\n      default:\n        console.warn(\`Unknown deep link path: \${path}\`);\n    }`
        : ""
    }
  } catch (err) {
    console.error("Invalid deep link URL:", url, err);
  }
}

// Handle deep link from app launch (cold start)
export function handleDeepLinkOnLaunch(): void {
  // Windows/Linux: URL is in process.argv
  const url = process.argv.find((arg) => arg.startsWith(\`\${PROTOCOL}://\`));
  if (url) {
    // Delay to ensure the window is ready
    setTimeout(() => handleDeepLink(url), 500);
  }
}`;

      const preloadAddition = `// Add to preload.ts
{
  onDeepLink: (callback: (data: { path: string; params: Record<string, string>; raw: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { path: string; params: Record<string, string>; raw: string }) => callback(data);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
}`;

      const builderConfig = `// electron-builder configuration
{
  "protocols": [
    {
      "name": "${proto} Protocol",
      "schemes": ["${proto}"]
    }
  ],
  "mac": {
    "extendInfo": {
      "CFBundleURLTypes": [
        {
          "CFBundleURLSchemes": ["${proto}"],
          "CFBundleURLName": "${proto} Protocol"
        }
      ]
    }
  },
  "linux": {
    "mimeTypes": ["x-scheme-handler/${proto}"]
  }
}`;

      const forgeConfig = `// Electron Forge configuration
{
  "packagerConfig": {
    "protocols": [
      {
        "name": "${proto} Protocol",
        "schemes": ["${proto}"]
      }
    ]
  }
}`;

      const entryUsage = `// src/main/index.ts
import { app } from "electron";
import { handleDeepLinkOnLaunch } from "./deep-link.js";

app.whenReady().then(() => {
  createMainWindow();
  // Cold-start deep link: on Windows/Linux the URL is in process.argv at launch.
  // Call AFTER the main window exists so handleDeepLink can forward to it.
  handleDeepLinkOnLaunch();
});`;

      const sections = [
        `# Deep Linking: ${proto}://\n`,
        `## Main Process\n\n\`\`\`typescript\n${mainCode}\n\`\`\``,
        `## Wire into the Main Entry Point\n\n\`\`\`typescript\n${entryUsage}\n\`\`\`\n\nCalling \`handleDeepLinkOnLaunch\` is what makes cold-start deep links work on Windows and Linux; the \`open-url\` listener already covers macOS and the \`second-instance\` listener covers subsequent launches.`,
        `## Preload Addition\n\n\`\`\`typescript\n${preloadAddition}\n\`\`\``,
        `## electron-builder Config\n\n\`\`\`json\n${builderConfig}\n\`\`\``,
        `## Electron Forge Config\n\n\`\`\`json\n${forgeConfig}\n\`\`\``,
        `## Testing Deep Links

\`\`\`bash
# macOS
open "${proto}://some/path?key=value"

# Windows (PowerShell)
Start-Process "${proto}://some/path?key=value"

# Linux
xdg-open "${proto}://some/path?key=value"
\`\`\``,
        `## Platform Notes

### macOS
- Protocol registration is via Info.plist (handled by the build config above)
- The \`open-url\` event fires when the app is already running
- On cold start, macOS passes the URL via the \`open-url\` event after \`ready\`

### Windows
- Protocol is registered in the Windows Registry (handled by the installer)
- On cold start, the URL is in \`process.argv\`
- On second instance, the URL is in the \`second-instance\` event's \`commandLine\`
- During development, \`process.defaultApp\` is true so the script path is added to the registry

### Linux
- Protocol is registered via .desktop file's MimeType field
- Behavior similar to Windows (URL in argv or second-instance)`,
      ];

      return sections.join("\n\n");
    },
  },

  {
    name: "electron_scaffold_project",
    description:
      "Generate a complete, secure, modern Electron project scaffold. Includes proper process separation, TypeScript configuration, framework integration, build tooling, security defaults, and an example IPC channel. Produces a full project structure ready to develop.",
    annotations: {
      title: "Scaffold Electron project",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      name: z.string().describe("Project name (lowercase, hyphens ok), e.g. 'my-electron-app'"),
      framework: z
        .enum(["react", "vue", "svelte", "vanilla"])
        .optional()
        .describe("Frontend framework. Defaults to 'react'."),
      buildTool: z
        .enum(["electron-forge", "electron-vite", "electron-builder"])
        .optional()
        .describe("Build tool. Defaults to 'electron-vite'."),
      features: z
        .array(z.enum(["auto-update", "tray", "deep-linking", "multi-window"]))
        .optional()
        .describe("Optional features to include"),
    }),
    handler: async (input: {
      name: string;
      framework?: string;
      buildTool?: string;
      features?: string[];
    }) => {
      const framework = input.framework || "react";
      const buildTool = input.buildTool || "electron-vite";
      const features = input.features || [];

      const sections: string[] = [];
      sections.push(`# Scaffold: ${input.name}\n`);

      // Recommend using the official scaffold command
      if (buildTool === "electron-vite") {
        sections.push(
          `## Quick Start (recommended)\n\n\`\`\`bash\nnpm create @quick-start/electron@latest ${input.name} -- --template ${framework}-ts\ncd ${input.name}\nnpm install\nnpm run dev\n\`\`\`\n\nThis uses electron-vite's official scaffolding. Below are the key files you'll want to customize.\n`,
        );
      } else if (buildTool === "electron-forge") {
        const template = framework === "react" ? "webpack-typescript" : "vite-typescript";
        sections.push(
          `## Quick Start (recommended)\n\n\`\`\`bash\nnpm init electron-app@latest ${input.name} -- --template=${template}\ncd ${input.name}\nnpm install\nnpm start\n\`\`\`\n\nThis uses Electron Forge's official scaffolding. Below are the key files you'll want to customize.\n`,
        );
      }

      // Project structure
      sections.push(`## Project Structure

\`\`\`
${input.name}/
├── src/
│   ├── main/
│   │   ├── index.ts          # Main process entry
│   │   └── ipc.ts            # IPC handlers
│   ├── preload/
│   │   └── index.ts          # Preload bridge
│   └── renderer/
│       ├── src/
│       │   ├── App.${framework === "vue" ? "vue" : framework === "svelte" ? "svelte" : "tsx"}
│       │   └── main.${framework === "vue" ? "ts" : framework === "svelte" ? "ts" : "tsx"}
│       └── index.html
├── electron.vite.config.ts   # ${buildTool === "electron-vite" ? "Build config" : "or equivalent"}
├── package.json
└── tsconfig.json
\`\`\``);

      // Main process
      const trayImport = features.includes("tray") ? ", Tray, Menu, nativeImage" : "";
      const mainCode = `// src/main/index.ts
import { app, BrowserWindow${trayImport} } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc.js";
${features.includes("auto-update") ? 'import { autoUpdater } from "electron-updater";\n' : ""}
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
${features.includes("tray") ? '\n  // Don\'t quit on window close -- hide to tray\n  win.on("close", (event) => {\n    event.preventDefault();\n    win.hide();\n  });\n' : ""}
  return win;
}
${features.includes("tray") ? `\nfunction createTray(win: BrowserWindow): Tray {\n  const icon = nativeImage.createFromPath(path.join(__dirname, "../../resources/icon.png"));\n  const tray = new Tray(icon.resize({ width: 16, height: 16 }));\n  tray.setContextMenu(Menu.buildFromTemplate([\n    { label: "Show", click: () => win.show() },\n    { type: "separator" },\n    { label: "Quit", click: () => { win.destroy(); app.quit(); } },\n  ]));\n  tray.on("click", () => win.show());\n  return tray;\n}\n` : ""}
app.whenReady().then(() => {
  const mainWindow = createMainWindow();
  registerIpcHandlers();
${features.includes("tray") ? "  createTray(mainWindow);\n" : ""}${features.includes("auto-update") ? "  autoUpdater.checkForUpdatesAndNotify();\n" : ""}
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});`;

      sections.push(`## Main Process\n\n\`\`\`typescript\n${mainCode}\n\`\`\``);

      // IPC handlers
      const ipcCode = `// src/main/ipc.ts
import { ipcMain, dialog, app } from "electron";

export function registerIpcHandlers(): void {
  // Example: get app version
  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });

  // Example: show open dialog
  ipcMain.handle("show-open-dialog", async (_event, options: Electron.OpenDialogOptions) => {
    return dialog.showOpenDialog(options);
  });

  // Example: get platform info
  ipcMain.handle("get-platform", () => {
    return { platform: process.platform, arch: process.arch };
  });
}`;

      sections.push(`## IPC Handlers\n\n\`\`\`typescript\n${ipcCode}\n\`\`\``);

      // Preload
      const preloadCode = `// src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  showOpenDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke("show-open-dialog", options),
  getPlatform: (): Promise<{ platform: string; arch: string }> => ipcRenderer.invoke("get-platform"),
});`;

      sections.push(`## Preload Bridge\n\n\`\`\`typescript\n${preloadCode}\n\`\`\``);

      // Type declarations
      const typesCode = `// src/types/electron.d.ts
export interface ElectronAPI {
  getAppVersion(): Promise<string>;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  getPlatform(): Promise<{ platform: string; arch: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}`;

      sections.push(`## Type Declarations\n\n\`\`\`typescript\n${typesCode}\n\`\`\``);

      // Security checklist
      sections.push(`## Security Checklist

After scaffolding, verify these settings:

- [x] contextIsolation: true (default since Electron 12)
- [x] sandbox: true (default since Electron 20)
- [x] nodeIntegration: false (default since Electron 5)
- [ ] Add Content Security Policy (use \`electron_configure_csp\`)
- [ ] Configure fuses for production (use \`electron_configure_fuses\`)
- [ ] Add will-navigate handler to restrict navigation
- [ ] Add setWindowOpenHandler to control popups
- [ ] Validate IPC sender in security-sensitive handlers`);

      return sections.join("\n\n");
    },
  },
] as const;
