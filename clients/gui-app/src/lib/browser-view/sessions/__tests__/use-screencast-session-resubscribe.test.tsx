import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  useScreencastSession,
  type ScreencastSession,
} from "@/lib/browser-view/sessions/use-screencast-session";
import { independentScope } from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

/**
 * D20's bounded resubscribe ladder. Before this ticket a `complete` was
 * terminal - the tile went to "Screencast ended." and stayed there until
 * someone reloaded the GUI - which made every routine cause of that frame (a
 * runtime flip landing the tab on Electron, the desktop that was mirroring it
 * quitting, a debugger detaching) read as a broken tab instead of a
 * reconnect. `useScreencastSession` now re-opens the subscription itself on a
 * retryable `complete`, with backoff that doubles from 250ms to a 4s cap and
 * gives up after 8 attempts so a permanently-gone tab stops costing the host
 * ERROR lines forever. `refused` and a non-retryable `complete` are the
 * opposite signal - re-subscribing changes nothing until the host does - and
 * must never enter the ladder at all.
 *
 * None of this is exercised by the viewport or handoff suites, which never
 * fire a `complete`, so it needs its own file and its own fake-timer control
 * of the 250ms/500ms/…/4s schedule.
 */

/**
 * One opened `browser.screencast` subscription - the round the ladder closes
 * and replaces on every bump. `harness.rounds.length` is this suite's
 * observable stand-in for "how many times has the hook subscribed": it grows
 * by exactly one each time the subscribe effect re-runs, whether that is the
 * initial mount or a resubscribe bump, so counting rounds is equivalent to
 * counting re-subscribes without reaching into the hook's private ref.
 */
interface Round {
  readonly fireFrame: (envelope: StreamFrameEnvelope) => void;
  readonly fireStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
  closed: boolean;
}

function createHarness(): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly rounds: Round[];
} {
  const rounds: Round[] = [];
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe() {
      let onFrame: ServerFrameHandler = () => {};
      let onStatus: StatusChangeHandler = () => {};
      const round: Round = {
        fireFrame: (envelope) => onFrame(envelope, null),
        fireStatus: (status, reason) => onStatus(status, reason, null),
        closed: false,
      };
      const session: IStreamSession = {
        sendClientFrame() {},
        onServerFrame(handler) {
          onFrame = handler;
        },
        onStatusChange(handler) {
          onStatus = handler;
          handler("connecting", null, null);
        },
        getNegotiatedSchemaVersion: () => null,
        requestReconnect() {},
        close() {
          round.closed = true;
        },
      };
      rounds.push(round);
      return session;
    },
    // Same three-method seam as the viewport/handoff harnesses: the
    // `independent` scope this file uses opens through
    // `subscribeAtScopeAddressedBrowserVersion`, which calls
    // `subscribeWithParamsProvider`, not `subscribe` directly.
    subscribeWithParamsProvider(method, paramsProvider) {
      return this.subscribe(method, paramsProvider(null));
    },
    subscribeAtVersion(method, _schemaVersion, params) {
      return this.subscribe(method, params);
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
    instanceId: "use-screencast-session-resubscribe-test-client",
  };
  return { client, rounds };
}

function completeFrame(retryable: boolean): StreamFrameEnvelope {
  return { kind: "complete", hasBinaryPayload: false, retryable };
}

function refusedFrame(): StreamFrameEnvelope {
  return { kind: "refused", hasBinaryPayload: false, reason: "test-reason" };
}

function jpegFrame(sequence: number): StreamFrameEnvelope {
  return {
    kind: "frame",
    hasBinaryPayload: true,
    sequence,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 800,
      deviceHeight: 600,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: sequence,
    },
  };
}

function Harness(props: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly tabStillListed: boolean;
  readonly onSession: (session: ScreencastSession) => void;
}): React.JSX.Element {
  const session = useScreencastSession({
    client: props.client,
    scope: independentScope(),
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    visible: true,
    tabStillListed: props.tabStillListed,
    onRequestNewTab: null,
    onRequestCloseTab: null,
    captureDormantSnapshot: () => {},
  });
  props.onSession(session);
  const {
    tileRef,
    viewportRef,
    videoRef,
    imageRef,
    overlayButtonRef,
    imeInputRef,
  } = session.refs;
  return (
    <div ref={tileRef}>
      <div ref={viewportRef}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the video plane's paint surface, not media content. */}
        <video ref={videoRef} />
        <img ref={imageRef} alt="surface" />
        <button ref={overlayButtonRef} type="button" />
        <input ref={imeInputRef} />
      </div>
    </div>
  );
}

describe("useScreencastSession resubscribe ladder (D20)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-opens after 250ms, doubles to a 4s cap, for at most 8 attempts, then stops", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    render(
      <Harness client={harness.client} tabStillListed onSession={() => {}} />,
    );
    expect(harness.rounds).toHaveLength(1);

    const expectedDelaysMs = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000];
    for (const [index, delayMs] of expectedDelaysMs.entries()) {
      // Every round below is asserted to exist by the length check that
      // precedes it, so the optional call is a formality the reader can ignore.
      act(() => {
        harness.rounds[index]?.fireFrame(completeFrame(true));
      });
      // The bump is scheduled, not applied - no new round yet.
      expect(harness.rounds).toHaveLength(index + 1);

      act(() => {
        vi.advanceTimersByTime(delayMs - 1);
      });
      expect(harness.rounds).toHaveLength(index + 1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(harness.rounds).toHaveLength(index + 2);
    }

    // The budget is spent: a 9th `complete` schedules nothing, so no 10th
    // round ever opens even after a very long wait.
    act(() => {
      harness.rounds[8]?.fireFrame(completeFrame(true));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(harness.rounds).toHaveLength(9);
  });

  it("never resubscribes on `complete { retryable: false }` - the tab is gone, not interrupted", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    render(
      <Harness client={harness.client} tabStillListed onSession={() => {}} />,
    );

    act(() => {
      harness.rounds[0]?.fireFrame(completeFrame(false));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(harness.rounds).toHaveLength(1);
  });

  it("never resubscribes on a `refused` frame - the remedy is on the host, not a retry", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    render(
      <Harness client={harness.client} tabStillListed onSession={() => {}} />,
    );

    act(() => {
      harness.rounds[0]?.fireFrame(refusedFrame());
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(harness.rounds).toHaveLength(1);
  });

  it("resets the attempt counter on the first `frame` of a subscription", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    render(
      <Harness client={harness.client} tabStillListed onSession={() => {}} />,
    );

    // Burn two attempts (250ms, then 500ms) so the next delay would be
    // 1000ms if the counter were not reset.
    act(() => {
      harness.rounds[0]?.fireFrame(completeFrame(true));
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      harness.rounds[1]?.fireFrame(completeFrame(true));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(harness.rounds).toHaveLength(3);

    // This round produces pixels - the reset.
    act(() => {
      harness.rounds[2]?.fireFrame(jpegFrame(1));
    });

    // A `complete` right after a delivered frame reschedules at the BASE
    // delay (250ms), not at the 1000ms the un-reset ladder would have used.
    act(() => {
      harness.rounds[2]?.fireFrame(completeFrame(true));
    });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(harness.rounds).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(harness.rounds).toHaveLength(4);
  });

  it("cancels a pending bump when the tab leaves session.info.tabs", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const view = render(
      <Harness client={harness.client} tabStillListed onSession={() => {}} />,
    );

    act(() => {
      harness.rounds[0]?.fireFrame(completeFrame(true));
    });
    // The tab disappears from the inventory before the 250ms timer fires -
    // the tile that stops listening for it, not the timer, is what proves
    // this: with no cancellation the bump would fire regardless.
    act(() => {
      view.rerender(
        <Harness
          client={harness.client}
          tabStillListed={false}
          onSession={() => {}}
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(harness.rounds).toHaveLength(1);
  });

  it('reads "Reconnecting…" instead of "Screencast ended." while a bump is pending, including after the stream itself closes', () => {
    vi.useFakeTimers();
    const harness = createHarness();
    // Held on an object rather than in a `let`: the assignment happens inside a
    // render callback, so control-flow analysis would otherwise keep narrowing
    // the local to `null` and force a cast at every read.
    const seen: { session: ScreencastSession | null } = { session: null };
    render(
      <Harness
        client={harness.client}
        tabStillListed
        onSession={(session) => {
          seen.session = session;
        }}
      />,
    );

    act(() => {
      harness.rounds[0]?.fireFrame(completeFrame(true));
    });
    if (seen.session === null) throw new Error("expected a session");
    expect(seen.session.lifecycle).toBe("connecting");
    expect(seen.session.details).toBe("Reconnecting…");

    // The host usually closes the transport right behind the `complete` that
    // started the ladder - that ordinary close must not overwrite the
    // "Reconnecting…" reading with "Screencast stream disconnected.".
    act(() => {
      harness.rounds[0]?.fireStatus("closed", null);
    });
    expect(seen.session.lifecycle).toBe("connecting");
    expect(seen.session.details).toBe("Reconnecting…");
  });
});
