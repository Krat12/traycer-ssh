import { afterEach, describe, expect, it } from "vitest";
import {
  reportHostTransportDiagnostic,
  setHostTransportDiagnosticSink,
} from "../transport-diagnostics";

describe("host transport diagnostics", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("records only bounded lifecycle fields and redacts line breaks", () => {
    const events: unknown[] = [];
    restore = setHostTransportDiagnosticSink((event) => {
      events.push(event);
    });

    reportHostTransportDiagnostic({
      plane: "ws",
      event: "socket-close",
      hostId: "host-1",
      clientId: "stream-client-1",
      method: "agent.activity.subscribe",
      code: 1006,
      reason: `bad\nline Bearer secret https://example.test/rpc?token=secret ${"x".repeat(500)}`,
    });

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      plane: "ws",
      event: "socket-close",
      hostId: "host-1",
      method: "agent.activity.subscribe",
      code: 1006,
    });
    expect(String(event.reason)).not.toContain("\n");
    expect(String(event.reason)).not.toContain("secret");
    expect(String(event.reason)).not.toContain("https://");
    expect(String(event.reason).length).toBeLessThanOrEqual(160);
    expect(event).not.toHaveProperty("token");
    expect(event).not.toHaveProperty("url");
  });
});
