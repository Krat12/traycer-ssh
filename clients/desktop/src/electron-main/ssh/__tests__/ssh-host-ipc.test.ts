// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { dialog } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import type { SshHostConnection } from "@traycer-clients/shared/platform/ssh-host";
import {
  registerSshHostIpc,
  type SshHostIpcBridge,
} from "../../ipc/ssh-host-ipc";

const mock = vi.hoisted(() => ({ getManager: vi.fn() }));
vi.mock("../ssh-host-service", () => ({ getSshHostManager: mock.getManager }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    powerMonitor: new EventEmitter(),
    dialog: { showMessageBox: vi.fn() },
  };
});

const profile = { hostId: "host-123", label: "Development", target: "dev-vm" };
const manager = {
  list: vi.fn(async (): Promise<readonly SshHostConnection[]> => []),
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  onChange: vi.fn(() => ({ dispose: vi.fn() })),
  resume: vi.fn(),
  dispose: vi.fn(),
};
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
>();
const bridge: SshHostIpcBridge = {
  disposeFns: [],
  handleInvoke: (channel, handler) => {
    handlers.set(channel, handler);
  },
  fanOut: vi.fn(),
};
async function invokeSave(value: unknown): Promise<void> {
  await handlers.get(RunnerHostInvoke.sshHostsSave)?.(null, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  manager.list.mockResolvedValue([]);
  mock.getManager.mockReturnValue(manager);
  registerSshHostIpc(bridge);
});
afterEach(() => {
  for (const dispose of bridge.disposeFns.splice(0)) dispose();
  handlers.clear();
});

describe("native SSH route admission", () => {
  it("requires native approval before a renderer can redirect browser sessions to a new SSH target", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    await expect(invokeSave(profile)).rejects.toThrow("not approved");
    expect(manager.save).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        message: expect.stringContaining(profile.target),
        detail: expect.stringContaining(profile.hostId),
      }),
    );
  });
  it("saves the exact approved route after native consent", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
    await invokeSave(profile);
    expect(manager.save).toHaveBeenCalledWith(profile);
  });
  it("does not prompt for unchanged approved routes, but target changes need fresh consent", async () => {
    manager.list.mockResolvedValue([
      {
        profile,
        state: "connected",
        websocketUrl: "ws://127.0.0.1:12345/rpc",
        version: "1.2.3",
        message: null,
      },
    ]);
    await invokeSave({ ...profile, label: "Renamed device" });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    await expect(
      invokeSave({ ...profile, target: "another-vm" }),
    ).rejects.toThrow("not approved");
    expect(manager.save).toHaveBeenCalledTimes(1);
  });
  it("validates hostile destinations before invoking native dialogs or saving", async () => {
    await expect(
      invokeSave({ ...profile, target: "-oProxyCommand=bad" }),
    ).rejects.toThrow("SSH config alias");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
  it("disposes eager startup tunnels even if no renderer ever requested a profile list", () => {
    for (const dispose of bridge.disposeFns.splice(0)) dispose();
    expect(manager.dispose).toHaveBeenCalledOnce();
  });
});
