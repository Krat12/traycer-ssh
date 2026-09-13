import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  useScreencastSession,
  type ScreencastSession,
} from "@/lib/browser-view/sessions/use-screencast-session";
import { epicScope } from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

/**
 * D01 retired the read-only viewer tier. Before this ticket,
 * `screencastRoleForShell` read `browserView` off the runner host and
 * answered `"viewer"` for both read-only shells - the web bundle (no runner
 * host at all) and `MobileRunnerHost` (`browserView: null`) - so the phone
 * subscribed at a tier the host refuses every claim and every input frame
 * from. `useScreencastSession` no longer reads a runner host at all: `role`
 * is hardcoded to `"tile"`, and `readOnly` is gone from the returned session
 * entirely rather than being computable and always `false`.
 *
 * This file pins both halves of that removal so a regression that
 * resurrected either one - a re-added runner-host read on the open request,
 * or a re-added `readOnly` field on the return value - fails here rather than
 * only showing up as a silent phone regression. It intentionally does not
 * construct any runner-host context: there is nothing left for the hook to
 * read, and a suite that provided one would not be testing the current code.
 */
function createHarness(): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly openParams: () => Readonly<Record<string, unknown>> | null;
} {
  let params: Record<string, unknown> | null = null;
  const session: IStreamSession = {
    sendClientFrame() {},
    onServerFrame() {},
    onStatusChange(handler) {
      handler("connecting", null, null);
    },
    getNegotiatedSchemaVersion: () => null,
    requestReconnect() {},
    close() {},
  };
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe(_method, subscribeParams) {
      params = subscribeParams as Record<string, unknown>;
      return session;
    },
    // The epic-scope open path (`openScreencastSubscription`) calls this one,
    // not `subscribe` directly - see `browser-screencast-stream-client.ts`.
    subscribeWithParamsProvider(method, paramsProvider) {
      return this.subscribe(method, paramsProvider(null));
    },
    subscribeAtVersion(method, _schemaVersion, subscribeParams) {
      return this.subscribe(method, subscribeParams);
    },
    close() {},
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated() {},
    notifyCloudVerdictChanged() {},
    reconnectAll() {},
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => {},
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => {},
    getClosedReason: () => null,
    onClosed: () => () => {},
    instanceId: "use-screencast-session-role-test-client",
  };
  return { client, openParams: () => params };
}

/**
 * Mounts the hook; nothing here reads its DOM, so the refs stay unattached.
 *
 * The session leaves through a PROP rather than a module-scope variable the
 * render writes: writing one from a component body is what the React-compiler
 * lint forbids, and the caller's closure keeps the value's type un-narrowed
 * without a cast.
 */
function Harness(props: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly onSession: (session: ScreencastSession) => void;
}): React.JSX.Element {
  const session = useScreencastSession({
    client: props.client,
    scope: epicScope("epic-1"),
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    visible: true,
    tabStillListed: true,
    onRequestNewTab: null,
    onRequestCloseTab: null,
    captureDormantSnapshot: () => {},
  });
  props.onSession(session);
  return <div />;
}

describe("useScreencastSession role (D01)", () => {
  it("declares `tile` on the open request from a shell with no native browser of its own", () => {
    const harness = createHarness();

    act(() => {
      render(<Harness client={harness.client} onSession={() => {}} />);
    });

    expect(harness.openParams()?.role).toBe("tile");
  });

  it("returns a session with no `readOnly` field to branch on", () => {
    const harness = createHarness();
    const seen: { session: ScreencastSession | null } = { session: null };

    act(() => {
      render(
        <Harness
          client={harness.client}
          onSession={(session) => {
            seen.session = session;
          }}
        />,
      );
    });

    if (seen.session === null) {
      throw new Error("expected useScreencastSession to return a session");
    }
    expect("readOnly" in seen.session).toBe(false);
  });
});
