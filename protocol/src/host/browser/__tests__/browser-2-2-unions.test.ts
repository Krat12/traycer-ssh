import { describe, expect, it } from "vitest";
import {
  browserScreencastServerFrameSchema,
  browserScreencastServerFrameV22Schema,
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
} from "@traycer/protocol/host/browser/contracts";

describe("browser.screencast@2.2 server frames", () => {
  it("parses a 2.0-shaped navState unchanged", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "navState",
      hasBinaryPayload: false,
      url: "https://example.com",
      canGoBack: false,
      canGoForward: true,
      loading: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a 2.1-shaped viewportEpoch unchanged", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "viewportEpoch",
      hasBinaryPayload: false,
      epoch: 3,
      logicalViewport: { width: 390, height: 844, dpr: 3 },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses refused", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "refused",
      hasBinaryPayload: false,
      reason: "mirror-unavailable",
    });
    expect(parsed.success).toBe(true);
  });

  it("parses editableFocus", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "editableFocus",
      hasBinaryPayload: false,
      focused: true,
      inputMode: "text",
      multiline: false,
      rect: { x: 0, y: 0, width: 100, height: 24 },
    });
    expect(parsed.success).toBe(true);
  });

  it("parses pointDescribed", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "pointDescribed",
      hasBinaryPayload: false,
      requestId: "request-1",
      link: "https://example.com",
      image: null,
      text: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses selectionText", () => {
    const parsed = browserScreencastServerFrameV22Schema.safeParse({
      kind: "selectionText",
      hasBinaryPayload: false,
      requestId: "request-1",
      text: "selected text",
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults retryable to true when complete omits it", () => {
    const parsed = browserScreencastServerFrameV22Schema.parse({
      kind: "complete",
      hasBinaryPayload: false,
    });
    expect(parsed).toMatchObject({ retryable: true });
  });
});

describe("the 2.1 unions reject 2.2-only shapes (regression guard for T02's projection)", () => {
  it("browserScreencastServerFrameSchema rejects refused", () => {
    expect(
      browserScreencastServerFrameSchema.safeParse({
        kind: "refused",
        hasBinaryPayload: false,
        reason: "mirror-unavailable",
      }).success,
    ).toBe(false);
  });

  it("browserSessionsServerFrameSchema rejects mirrorRequest", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "mirrorRequest",
        hasBinaryPayload: false,
        mirrorId: "mirror-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        params: {
          maxWidth: 800,
          maxHeight: 600,
          quality: 80,
          everyNthFrame: 1,
        },
      }).success,
    ).toBe(false);
  });

  it("browserSessionsServerFrameSchema rejects a viewportState carrying fitPointer", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "viewportState",
        hasBinaryPayload: false,
        sessionId: "session-1",
        tabId: "tab-1",
        intent: { mode: "fit" },
        applied: null,
        revision: 0,
        source: null,
        fitOwnerId: null,
        fitPointer: "fine",
      }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@2.x shared client frames", () => {
  it('reportViewport without pointer parses to "fine"', () => {
    const parsed = browserSessionsClientFrameSchema.parse({
      kind: "reportViewport",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      viewerId: "viewer-1",
      claim: true,
      width: 390,
      height: 844,
      dpr: 3,
    });
    expect(parsed).toMatchObject({ pointer: "fine" });
  });

  it("electronTabLifecycleReady without mirror parses to false", () => {
    const parsed = browserSessionsClientFrameSchema.parse({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: null,
    });
    expect(parsed).toMatchObject({ mirror: false });
  });
});
