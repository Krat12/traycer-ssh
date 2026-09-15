import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ISshHostManager,
  SshHostConnection,
  SshHostProfile,
} from "@traycer-clients/shared/platform/ssh-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { SshHostConnectionCard } from "../ssh-host-connection-card";

afterEach(cleanup);

function renderCard() {
  let connections: readonly SshHostConnection[] = [];
  const listeners = new Set<(value: readonly SshHostConnection[]) => void>();
  const publish = (next: readonly SshHostConnection[]) => {
    connections = next;
    for (const listener of listeners) listener(next);
  };
  const save = vi.fn((profile: SshHostProfile) => {
    publish([
      {
        profile,
        state: "connecting",
        websocketUrl: null,
        version: null,
        message: null,
      },
    ]);
    return Promise.resolve();
  });
  const reconnect = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => {
    publish([]);
    return Promise.resolve();
  });
  const manager: ISshHostManager = {
    list: () => Promise.resolve(connections),
    save,
    reconnect,
    remove,
    onChange: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://auth.test/sign-in",
      authnBaseUrl: "https://auth.test",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: false,
      traycerCli: undefined,
    }),
    { sshHosts: manager },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <SshHostConnectionCard hostId="linux-host" hostLabel="Linux dev" />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { save, reconnect, remove, publish, listeners };
}

describe("SSH settings for an existing Host", () => {
  it("saves the selected Host, observes status, reconnects and switches back", async () => {
    const fixture = renderCard();
    const input = await screen.findByLabelText("SSH target");
    fireEvent.change(input, { target: { value: " linux-dev " } });
    fireEvent.click(screen.getByRole("button", { name: "Use SSH" }));
    await waitFor(() =>
      expect(fixture.save).toHaveBeenCalledWith({
        hostId: "linux-host",
        label: "Linux dev",
        target: "linux-dev",
      }),
    );
    await screen.findByText("Connecting");
    act(() =>
      fixture.publish([
        {
          profile: {
            hostId: "linux-host",
            label: "Linux dev",
            target: "linux-dev",
          },
          state: "connected",
          websocketUrl: "ws://127.0.0.1:44001/rpc",
          version: "1.3.1",
          message: null,
        },
      ]),
    );
    await screen.findByText("Connected via SSH");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect SSH" }));
    await waitFor(() =>
      expect(fixture.reconnect).toHaveBeenCalledWith("linux-host"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Use Traycer connection" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use Traycer connection" }),
    );
    await waitFor(() =>
      expect(fixture.remove).toHaveBeenCalledWith("linux-host"),
    );
    await screen.findByText("Traycer connection");
    cleanup();
    expect(fixture.listeners.size).toBe(0);
  });

  it("keeps connection failures next to the editable target", async () => {
    const fixture = renderCard();
    await screen.findByLabelText("SSH target");
    act(() =>
      fixture.publish([
        {
          profile: {
            hostId: "linux-host",
            label: "Linux dev",
            target: "linux-dev",
          },
          state: "error",
          websocketUrl: null,
          version: null,
          message: "SSH connection failed. Check your OpenSSH profile.",
        },
      ]),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Check your OpenSSH profile",
    );
    expect(screen.getByLabelText("SSH target")).toHaveProperty(
      "value",
      "linux-dev",
    );
    expect(
      screen.getByRole("button", { name: "Reconnect SSH" }),
    ).toHaveProperty("disabled", false);
  });
});
