// Build the independent SSH application. Never invokes Host/CLI provisioning
// or the upstream deployment stamper, which restores the official identity.
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopRoot = resolve(__dirname, "..");
const configPath = resolve(desktopRoot, "src/config.ts");
const source = readFileSync(configPath, "utf8");
const version = process.env.TRAYCER_SSH_VERSION || "0.1.0-ssh.1";
if (!/^\d+\.\d+\.\d+-ssh\.\d+$/.test(version)) {
  throw new Error("TRAYCER_SSH_VERSION must look like 0.1.0-ssh.1");
}
if (!process.env.VITE_DESKTOP_LOCAL_STORAGE_KEY) {
  throw new Error(
    "Set VITE_DESKTOP_LOCAL_STORAGE_KEY to a stable build key. Keep the same value for subsequent builds.",
  );
}
if (process.platform !== "win32" && !process.argv.includes("--dir")) {
  throw new Error(
    "Build the Windows installer on Windows, or use --dir for a local smoke build.",
  );
}
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_APP_VERSION: version,
      VITE_TRAYCER_OSS_REPO: "Krat12/traycer-ssh",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Build step failed (${result.status}): ${args.join(" ")}`);
}
try {
  writeFileSync(
    configPath,
    source
      .replace(
        'environment: "dev" as Environment',
        'environment: "production" as Environment',
      )
      .replace('version: "0.0.0-dev"', `version: "${version}"`)
      .replace('appName: "Traycer SSH Dev"', 'appName: "Traycer SSH"'),
  );
  run(["run", "build:app"]);
  run(["run", "prepack:check-icons"]);
  run(["run", "prepack:check-tray"]);
  run([
    "x",
    "electron-builder",
    "--publish",
    "never",
    `--config.extraMetadata.version=${version}`,
    "--config.extraMetadata.name=traycer-ssh",
    ...(process.argv.includes("--dir")
      ? ["--dir"]
      : ["--win", "nsis", "--x64"]),
  ]);
} finally {
  writeFileSync(configPath, source);
}
