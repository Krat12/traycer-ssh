import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./browser-debug-session-test-support";
import type { BrowserDebugCdpEvent } from "../browser-debug-session";

// `../../../app/logger` - three levels, because this file sits one deeper than
// the module under test. The real one imports `electron`, which cannot load in
// a vitest worker.
vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

/**
 * `onCdpEvent` is the mirror's whole read side of the shared attachment. Two
 * things about it are load-bearing and neither is obvious from the call site:
 * it sits BEFORE the telemetry recorder, which claims the events it handles by
 * returning `true` and drops every event nobody routed; and it holds the
 * `message` listener open on its own, because a mirror is a standing
 * subscription that must outlive the domains going idle.
 */
describe("BrowserDebugSession.onCdpEvent", () => {
  it("fans an event out to every listener, including one telemetry would claim", async () => {
    const harness = createHarness();
    const first: BrowserDebugCdpEvent[] = [];
    const second: BrowserDebugCdpEvent[] = [];
    await harness.session.enableAfterCommit();
    harness.session.onCdpEvent((event) => {
      first.push(event);
    });
    harness.session.onCdpEvent((event) => {
      second.push(event);
    });

    harness.webContents.debugger.emitMessage(
      "Page.screencastFrame",
      { data: "aaaa", sessionId: 7 },
      undefined,
    );
    // `Log.entryAdded` is one of the kinds `BrowserDebugTelemetry.handleEvent`
    // returns `true` for. A fan-out placed after that early return would see
    // the screencast frame and never this.
    harness.webContents.debugger.emitMessage(
      "Log.entryAdded",
      { entry: { text: "hello", level: "warning" } },
      undefined,
    );

    expect(first.map((event) => event.method)).toEqual([
      "Page.screencastFrame",
      "Log.entryAdded",
    ]);
    expect(second.map((event) => event.method)).toEqual([
      "Page.screencastFrame",
      "Log.entryAdded",
    ]);
    expect(first[0]?.params).toEqual({ data: "aaaa", sessionId: 7 });
    expect(first[0]?.sessionId).toBeUndefined();
  });

  it("holds the message listener open while the domains are disabled, and drops it on the last unsubscribe", () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    // Attached with NO domain enabled and no enable in flight:
    // `stopListeningIfIdle`'s other three reasons to keep the `message`
    // subscription are all absent, so the mirror's listener set is the only
    // thing that can hold it. Every `sendCommand` runs that predicate in its
    // `finally`, which is how a live mirror used to die silently.
    browserDebugger.attach("1.3");
    const events: string[] = [];
    const first = harness.session.onCdpEvent((event) => {
      events.push(`a:${event.method}`);
    });
    const second = harness.session.onCdpEvent((event) => {
      events.push(`b:${event.method}`);
    });

    browserDebugger.emitMessage("Page.frameResized", {}, undefined);
    expect(events).toEqual(["a:Page.frameResized", "b:Page.frameResized"]);

    first();
    browserDebugger.emitMessage("Page.frameResized", {}, undefined);
    expect(events).toEqual([
      "a:Page.frameResized",
      "b:Page.frameResized",
      "b:Page.frameResized",
    ]);

    second();
    browserDebugger.emitMessage("Page.frameResized", {}, undefined);
    expect(events).toHaveLength(3);
  });

  it("routes a child-target event with its session id rather than dropping it", async () => {
    const harness = createHarness();
    await harness.session.enableAfterCommit();
    const events: BrowserDebugCdpEvent[] = [];
    harness.session.onCdpEvent((event) => {
      events.push(event);
    });

    harness.webContents.debugger.emitMessage(
      "Page.screencastFrame",
      { data: "bbbb", sessionId: 1 },
      "child-1",
    );

    // Handed over as-is; deciding an OOPIF's frames are not the mirror's is the
    // consumer's call, and it needs the session id to make it.
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe("child-1");
  });
});
