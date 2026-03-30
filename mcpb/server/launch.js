#!/usr/bin/env node
/**
 * nteract MCP Server Launcher
 *
 * Finds and launches the nteract MCP server (runt mcp) for the appropriate
 * channel (stable or nightly). The channel is determined by the NTERACT_CHANNEL
 * env var, set by the manifest's mcp_config.
 *
 * Search order:
 * 1. PATH (covers /usr/local/bin/ where the app installer puts the binary)
 * 2. Platform-specific app bundle / install locations
 *
 * No fallback between channels — stable only looks for `runt`,
 * nightly only looks for `runt-nightly`.
 */

const { execFileSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const channel = process.env.NTERACT_CHANNEL || "stable";
const binaryName = channel === "nightly" ? "runt-nightly" : "runt";
const appName = channel === "nightly" ? "nteract Nightly" : "nteract";

/** App bundle name candidates — must match runt_workspace::desktop_app_launch_candidates_for(). */
const appBundleNames =
  channel === "nightly"
    ? ["nteract Nightly", "nteract-nightly", "nteract (Nightly)"]
    : ["nteract"];

/** Platform-specific paths where the app installs the binary. */
function sidecarPaths() {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  switch (process.platform) {
    case "darwin": {
      // The binary is in Contents/MacOS (not Resources/sidecars)
      // See: cli_install::get_bundled_runt_path
      const paths = [];
      for (const name of appBundleNames) {
        paths.push(`/Applications/${name}.app/Contents/MacOS/${binaryName}`);
        paths.push(
          join(home, `Applications/${name}.app/Contents/MacOS/${binaryName}`),
        );
      }
      return paths;
    }
    case "win32": {
      const localAppData =
        process.env.LOCALAPPDATA || join(home, "AppData/Local");
      const paths = [];
      for (const name of appBundleNames) {
        paths.push(join(localAppData, `${name}/${binaryName}.exe`));
        paths.push(join(localAppData, `Programs/${name}/${binaryName}.exe`));
      }
      return paths;
    }
    case "linux": {
      // See: find_bundled_runtimed() — searches /usr/share and /opt
      const paths = [join(home, `.local/bin/${binaryName}`)];
      for (const name of appBundleNames) {
        const slug = name.toLowerCase().replace(/ /g, "-");
        paths.push(`/usr/share/${slug}/${binaryName}`);
        paths.push(`/opt/${slug}/${binaryName}`);
      }
      return paths;
    }
    default:
      return [];
  }
}

/** Find the binary in PATH or platform-specific locations. */
function findBinary() {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  const bin =
    process.platform === "win32" ? `${binaryName}.exe` : binaryName;

  // 1. Check PATH
  try {
    execFileSync(whichCmd, [bin], { stdio: "pipe" });
    return bin;
  } catch {
    // Not in PATH — check platform-specific locations
  }

  // 2. Check sidecar / install paths
  for (const candidate of sidecarPaths()) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const log = (msg) => process.stderr.write(`[nteract-launcher] ${msg}\n`);

log(`channel=${channel}, binary=${binaryName}, platform=${process.platform}`);

const binary = findBinary();

if (!binary) {
  log(`ERROR: ${binaryName} not found in PATH or sidecar paths`);
  log(`Searched sidecar paths: ${JSON.stringify(sidecarPaths())}`);
  process.stderr.write(
    `\nInstall ${appName} from https://nteract.io to use this MCP server.\n` +
      `The app puts ${binaryName} on your PATH during installation.\n`,
  );
  process.exit(1);
}

log(`Found binary: ${binary}`);
log(`Launching: ${binary} mcp`);

// Launch runt mcp with piped stdio — forward between this process and the child.
const child = spawn(binary, ["mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

log(`Child spawned, pid=${child.pid}`);

// Forward stdin from this process to the child
process.stdin.on("data", (chunk) => {
  log(`stdin → child: ${chunk.length} bytes`);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  log("stdin ended");
  child.stdin.end();
});

// Forward stdout from the child to this process
child.stdout.on("data", (chunk) => {
  log(`child → stdout: ${chunk.length} bytes`);
  process.stdout.write(chunk);
});

child.on("error", (err) => {
  log(`Child error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  log(`Child exited: code=${code}, signal=${signal}`);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
