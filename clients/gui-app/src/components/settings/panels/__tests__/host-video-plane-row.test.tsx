import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { toast } from "sonner";
import { HostVideoPlaneRow } from "@/components/settings/panels/host-video-plane-row";
import {
  buildConfigHostFixture,
  CONFIG_HOST_SETTINGS_METHODS,
  type ConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

const HOST_ID = "host-a";
const TESTID = "settings-host-video-plane";

function renderRow(options: {
  readonly hostSettings?: {
    browserVideoPlane: boolean | null;
    effective: boolean;
  };
  readonly hostPlatform?: string | null;
  readonly methods?: readonly string[] | null;
  readonly overrideHandlers?: Parameters<
    typeof buildConfigHostFixture
  >[0]["overrideHandlers"];
}): { readonly fixture: ConfigHostFixture; readonly queryClient: QueryClient } {
  const fixture = buildConfigHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    hostSettings: options.hostSettings,
    overrideHandlers: options.overrideHandlers,
  });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(
      HOST_ID,
      options.methods ?? CONFIG_HOST_SETTINGS_METHODS,
    );
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostVideoPlaneRow
        hostId={HOST_ID}
        client={fixture.client}
        enabled
        hostPlatform={options.hostPlatform ?? "darwin-arm64"}
      />
    </QueryClientProvider>,
  );
  return { fixture, queryClient };
}

async function openSelect(): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const element = screen.getByTestId(TESTID);
    if (element.hasAttribute("disabled")) {
      throw new Error("Video plane select still disabled");
    }
    return element;
  });
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(trigger);
  return trigger;
}

async function chooseOption(label: string | RegExp): Promise<void> {
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

describe("<HostVideoPlaneRow />", () => {
  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    vi.mocked(toast.error).mockClear();
  });

  it("renders nothing when config.hostSettings.get is unsupported", async () => {
    renderRow({ methods: null });

    // No handshake recorded at all - the gate must fail closed, not render a
    // disabled placeholder.
    await waitFor(() => {
      expect(screen.queryByTestId(TESTID)).toBeNull();
    });
    expect(
      screen.queryByText("Low-latency video for remote viewing"),
    ).toBeNull();
  });

  it("renders the default-off state and the macOS prompt copy when supported", async () => {
    renderRow({ hostSettings: { browserVideoPlane: null, effective: false } });

    expect(
      await screen.findByText("Low-latency video for remote viewing"),
    ).toBeTruthy();
    expect(
      await screen.findByText(/Platform default \(off on macOS\)/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /turning this on makes the host ask for Screen Recording/,
      ),
    ).toBeTruthy();
  });

  it("turning it on sends { browserVideoPlane: true } and renders the refetched value", async () => {
    const { fixture } = renderRow({
      hostSettings: { browserVideoPlane: null, effective: false },
    });
    await screen.findByText(/Platform default/);

    await openSelect();
    await chooseOption("On");

    await waitFor(() => {
      expect(fixture.setHostSettingsCalls).toContainEqual({
        browserVideoPlane: true,
      });
    });
    expect(await screen.findByText("On")).toBeTruthy();
  });

  it("returning to Platform default sends { browserVideoPlane: null }", async () => {
    const { fixture } = renderRow({
      hostSettings: { browserVideoPlane: true, effective: true },
    });
    await screen.findByText("On");

    await openSelect();
    await chooseOption(/Platform default/);

    await waitFor(() => {
      expect(fixture.setHostSettingsCalls).toContainEqual({
        browserVideoPlane: null,
      });
    });
    await screen.findByText(/Platform default/);
  });

  it("surfaces a failed set and leaves the previous value rendered", async () => {
    renderRow({
      hostSettings: { browserVideoPlane: null, effective: false },
      overrideHandlers: {
        "config.hostSettings.set": () => {
          throw new Error("set failed");
        },
      },
    });
    await screen.findByText(/Platform default \(off on macOS\)/);

    await openSelect();
    await chooseOption("On");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // The mutation rejected, so the row keeps showing the last known-good
    // value rather than the choice that failed to save.
    expect(screen.getByText(/Platform default \(off on macOS\)/)).toBeTruthy();
    expect(screen.queryByText("On")).toBeNull();
  });

  it("disables the control while the mutation is in flight", async () => {
    let resolveSet = (): void => {};
    renderRow({
      hostSettings: { browserVideoPlane: null, effective: false },
      overrideHandlers: {
        "config.hostSettings.set": (request) =>
          new Promise((resolve) => {
            resolveSet = () =>
              resolve({
                browserVideoPlane: request.browserVideoPlane,
                effective: request.browserVideoPlane ?? false,
              });
          }),
      },
    });
    await screen.findByText(/Platform default/);

    await openSelect();
    await chooseOption("On");

    await waitFor(() => {
      expect(screen.getByTestId(TESTID).hasAttribute("disabled")).toBe(true);
    });

    resolveSet();

    await waitFor(() => {
      expect(screen.getByTestId(TESTID).hasAttribute("disabled")).toBe(false);
    });
  });
});
