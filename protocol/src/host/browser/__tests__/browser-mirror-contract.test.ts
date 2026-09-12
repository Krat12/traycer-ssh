import { describe, expect, it } from "vitest";
import {
  browserMirrorClientFrameSchema,
  browserMirrorOpenRequestSchema,
} from "@traycer/protocol/host/browser/mirror-contracts";

const METADATA = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 390,
  deviceHeight: 844,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  timestamp: 0,
};

describe("browser.mirror@1.0 client frames", () => {
  it("accepts a frame with hasBinaryPayload: true and metadata.offsetTop present", () => {
    const parsed = browserMirrorClientFrameSchema.safeParse({
      kind: "frame",
      hasBinaryPayload: true,
      sequence: 0,
      metadata: METADATA,
      applied: { width: 390, height: 844, dpr: 3 },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a frame whose metadata is missing offsetTop", () => {
    const { offsetTop: _offsetTop, ...metadataWithoutOffsetTop } = METADATA;
    const parsed = browserMirrorClientFrameSchema.safeParse({
      kind: "frame",
      hasBinaryPayload: true,
      sequence: 0,
      metadata: metadataWithoutOffsetTop,
      applied: { width: 390, height: 844, dpr: 3 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("browser.mirror@1.0 open request", () => {
  const VALID_OPEN_REQUEST = {
    mirrorId: "mirror-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
  };

  it("parses the exact expected shape", () => {
    expect(
      browserMirrorOpenRequestSchema.safeParse(VALID_OPEN_REQUEST).success,
    ).toBe(true);
  });

  it("rejects unknown keys", () => {
    const parsed = browserMirrorOpenRequestSchema.safeParse({
      ...VALID_OPEN_REQUEST,
      extra: "not-allowed",
    });
    expect(parsed.success).toBe(false);
  });
});
