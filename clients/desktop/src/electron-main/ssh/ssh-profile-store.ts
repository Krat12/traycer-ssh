import { open, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SshHostProfile } from "@traycer-clients/shared/platform/ssh-host";
import { parseSshProfile } from "./ssh-validation";

export interface SshProfileStore {
  load(): Promise<readonly SshHostProfile[]>;
  save(profiles: readonly SshHostProfile[]): Promise<void>;
}

/** The path is always the fork's userData, never ~/.traycer. */
export class FileSshProfileStore implements SshProfileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<readonly SshHostProfile[]> {
    try {
      const handle = await open(this.path, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65_536)
          throw new Error("Invalid SSH profile file.");
        const raw: unknown = JSON.parse(await handle.readFile("utf8"));
        if (!Array.isArray(raw) || raw.length > 32)
          throw new Error("Invalid SSH profile file.");
        const profiles = raw.map((value: unknown) => parseSshProfile(value));
        if (
          new Set(profiles.map((profile) => profile.hostId)).size !==
          profiles.length
        )
          throw new Error("Duplicate SSH Host identity.");
        return profiles;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      // Corruption must not make saved SSH routes silently become cloud routes.
      throw new Error(
        "Cannot read saved SSH profiles. Check the Traycer SSH application data folder.",
      );
    }
  }

  async save(profiles: readonly SshHostProfile[]): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify(profiles), {
        mode: 0o600,
      });
      await rename(`${this.path}.tmp`, this.path);
    } catch {
      throw new Error(
        "Cannot save SSH profiles in the Traycer SSH application data folder.",
      );
    }
  }
}
