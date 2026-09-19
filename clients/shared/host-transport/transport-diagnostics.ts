/**
 * Bounded, structured lifecycle diagnostics for the local Host transport.
 *
 * This is deliberately a tiny seam instead of ad-hoc logging at each caller:
 * the event shape has no token, URL, prompt, or frame payload fields, and the
 * sanitizer bounds the few remote strings that are useful when diagnosing a
 * reconnect loop. Desktop can route the default console line to its existing
 * log bridge; tests install a sink without touching global console spies.
 */
export interface HostTransportDiagnostic {
  readonly at: string;
  readonly plane: "ssh" | "ws";
  readonly event: string;
  readonly hostId?: string;
  readonly clientId?: string;
  readonly method?: string;
  readonly state?: string;
  readonly phase?: string;
  readonly attempt?: number;
  readonly code?: number | string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly delayMs?: number;
}

export type HostTransportDiagnosticSink = (
  event: HostTransportDiagnostic,
) => void;

const MAX_REASON_CHARS = 160;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

let sink: HostTransportDiagnosticSink = (event) => {
  // JSON is one line and contains only the fields above. Never append raw SSH
  // stderr or a WebSocket frame here: those may contain credentials/URLs.
  console.info(`[transport] ${JSON.stringify(event)}`);
};

export function reportHostTransportDiagnostic(
  event: Omit<HostTransportDiagnostic, "at">,
): void {
  const reason = event.reason;
  const boundedReason =
    reason === undefined ? undefined : sanitizeDiagnosticReason(reason);
  sink({
    ...event,
    ...(boundedReason === undefined ? {} : { reason: boundedReason }),
    at: new Date().toISOString(),
  });
}

/** Desktop main installs its persistent log sink here; tests can restore it. */
export function setHostTransportDiagnosticSink(
  next: HostTransportDiagnosticSink | null,
): () => void {
  const previous = sink;
  sink =
    next ??
    ((event) => {
      console.info(`[transport] ${JSON.stringify(event)}`);
    });
  return () => {
    sink = previous;
  };
}

export function sanitizeDiagnosticReason(reason: string): string {
  const normalized = reason
    .slice(0, MAX_REASON_CHARS * 2)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:token|key|secret|password)[=:])[^,\s]+/gi, "$1[redacted]")
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, "[url redacted]")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return "<empty>";
  return normalized.length > MAX_REASON_CHARS
    ? `${normalized.slice(0, MAX_REASON_CHARS - 1)}…`
    : normalized;
}
