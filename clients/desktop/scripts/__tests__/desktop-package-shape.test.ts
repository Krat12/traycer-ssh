/**
 * Static guard against Desktop package-shape regressions tied to the
 * native-packaging cleanup (see ticket
 * f613895a-bdb0-4a95-b1e6-b974ee7dafa0).
 *
 * Pins the `electron-builder` `extraResources` declarations in
 * `clients/desktop/package.json` so:
 *
 *   - Desktop **does not** stage `../../traycer-host/resources` (or
 *     anything else) under `host/client-assets`. Host-side client
 *     assets travel with the native host SEA / runtime archive cut
 *     by the host release workflows, not Desktop.
 *   - Desktop **does not** reintroduce a bundled host executable, a
 *     host runtime, a developer Node binary, a host wrapper, or a
 *     service plist via `extraResources`.
 *   - The SSH edition contains no Host or CLI resources and cannot
 *     install, update, or uninstall the official Host.
 *
 * The test reads the JSON directly (not the workflow YAMLs) so a hand
 * edit to `package.json` is gated independently of CI workflow drift.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const DESKTOP_PACKAGE_JSON = path.join(
  REPO_ROOT,
  "clients",
  "desktop",
  "package.json",
);

interface ExtraResourceEntry {
  readonly from: string;
  readonly to: string;
  readonly filter: ReadonlyArray<string>;
}

interface PlatformExtraResources {
  readonly mac: ReadonlyArray<ExtraResourceEntry>;
  readonly win: ReadonlyArray<ExtraResourceEntry>;
  readonly linux: ReadonlyArray<ExtraResourceEntry>;
}

interface ParsedDesktopPackage {
  readonly extraResources: ReadonlyArray<ExtraResourceEntry>;
  readonly platformExtraResources: PlatformExtraResources;
  readonly winIcon: string | undefined;
}

interface PlatformBuildSection {
  readonly icon?: string;
  readonly extraResources?: ReadonlyArray<ExtraResourceEntry>;
}

function readDesktopPackage(): ParsedDesktopPackage {
  const raw = readFileSync(DESKTOP_PACKAGE_JSON, "utf8");
  const parsed: {
    build?: {
      extraResources?: ReadonlyArray<ExtraResourceEntry>;
      mac?: PlatformBuildSection;
      win?: PlatformBuildSection;
      linux?: PlatformBuildSection;
    };
  } = JSON.parse(raw);
  const extraResources = parsed.build?.extraResources ?? [];
  return {
    extraResources,
    platformExtraResources: {
      mac: parsed.build?.mac?.extraResources ?? [],
      win: parsed.build?.win?.extraResources ?? [],
      linux: parsed.build?.linux?.extraResources ?? [],
    },
    winIcon: parsed.build?.win?.icon,
  };
}

/**
 * Every `extraResources` entry electron-builder will evaluate for a given
 * platform: the top-level list plus that platform's own list (app-builder-lib
 * `getFileMatchers` concatenates the two - platform entries ADD to the
 * top-level ones, they do not replace them).
 */
function allExtraResourcesFor(
  pkg: ParsedDesktopPackage,
  platform: keyof PlatformExtraResources,
): ReadonlyArray<ExtraResourceEntry> {
  return [...pkg.extraResources, ...pkg.platformExtraResources[platform]];
}

describe("desktop package.json - extraResources shape", () => {
  const pkg = readDesktopPackage();

  it("does not stage anything under host/client-assets", () => {
    const offenders = pkg.extraResources.filter(
      (entry) => entry.to === "host/client-assets",
    );
    expect(offenders).toEqual([]);
  });

  it("does not stage anything under the host namespace", () => {
    const hostNamespaceEntries = pkg.extraResources.filter(
      (entry) => entry.to === "host" || entry.to.startsWith("host/"),
    );
    expect(hostNamespaceEntries).toEqual([]);
  });

  it("does not pull from the traycer-host source tree at all", () => {
    const fromTraycerHost = pkg.extraResources.filter((entry) =>
      entry.from.includes("traycer-host"),
    );
    expect(fromTraycerHost).toEqual([]);
  });

  it("does not reintroduce a bundled host executable, runtime, dev Node binary, host wrapper, or service plist", () => {
    const forbiddenSources = [
      /traycer-host\/dist/,
      /traycer-host\/sea/,
      /traycer-host\/runtime/,
      /traycer-host\/.*\/(node|bun)$/,
      /host-wrapper/i,
      /\.plist$/,
    ];
    for (const entry of pkg.extraResources) {
      for (const pattern of forbiddenSources) {
        expect(
          entry.from,
          `extraResources entry from='${entry.from}' to='${entry.to}' matched forbidden pattern ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("does not map resources/cli arch-blind at the top level", () => {
    const archBlind = pkg.extraResources.filter(
      (entry) =>
        entry.to === "cli" ||
        entry.to.startsWith("cli/") ||
        entry.from === "resources/cli" ||
        entry.from.startsWith("resources/cli/"),
    );
    expect(archBlind).toEqual([]);
  });

  it.each(["mac", "win", "linux"] as const)(
    "does not bundle the CLI on %s",
    (platform) => {
      const cliEntries = allExtraResourcesFor(pkg, platform).filter(
        (entry) => entry.to === "cli" || entry.to.startsWith("cli/"),
      );
      expect(cliEntries).toEqual([]);
    },
  );

  it("keeps installation and protocol registration separate from the official app", () => {
    const raw: {
      build: {
        appId: string;
        productName: string;
        publish: unknown;
        afterPack?: string;
        protocols: ReadonlyArray<{ schemes: ReadonlyArray<string> }>;
        nsis: { include?: string; deleteAppDataOnUninstall: boolean };
      };
    } = JSON.parse(readFileSync(DESKTOP_PACKAGE_JSON, "utf8"));
    expect(raw.build.appId).toBe("io.github.krat12.traycer-ssh");
    expect(raw.build.productName).toBe("Traycer SSH");
    expect(raw.build.protocols.flatMap((entry) => entry.schemes)).toEqual([
      "traycer-ssh",
    ]);
    expect(raw.build.publish).toBeNull();
    expect(raw.build.afterPack).toBeUndefined();
    expect(raw.build.nsis.include).toBeUndefined();
    expect(raw.build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("embeds the Windows app icon for Start menu and desktop shortcuts", () => {
    expect(pkg.winIcon).toBe("icon.ico");
  });
});
