// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSshProfileStore } from "../ssh-profile-store";

const directories: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "traycer-ssh-profiles-"));
  directories.push(directory);
  const path = join(directory, "ssh-hosts.json");
  return { path, store: new FileSshProfileStore(path) };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("SSH profile persistence", () => {
  it("starts empty only for a missing file and restores an atomically saved profile", async () => {
    const { store } = await setup();
    expect(await store.load()).toEqual([]);
    const profiles = [
      { hostId: "linux-host", label: "Linux", target: "dev-vm" },
    ];
    await store.save(profiles);
    expect(await store.load()).toEqual(profiles);
  });
  it("keeps a corrupt file intact and refuses to reinterpret its routes as cloud connections", async () => {
    const { path, store } = await setup();
    await writeFile(path, "{broken");
    await expect(store.load()).rejects.toThrow(
      "Cannot read saved SSH profiles",
    );
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
  it("refuses an oversized file or duplicate Host identities", async () => {
    const { path, store } = await setup();
    await writeFile(path, " ".repeat(65_537));
    await expect(store.load()).rejects.toThrow(
      "Cannot read saved SSH profiles",
    );
    const profile = { hostId: "same-host", label: "Linux", target: "dev-vm" };
    await writeFile(path, JSON.stringify([profile, profile]));
    await expect(store.load()).rejects.toThrow(
      "Cannot read saved SSH profiles",
    );
  });
});
