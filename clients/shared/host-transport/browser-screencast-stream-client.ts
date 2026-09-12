import {
  browserScreencastServerFrameV22Schema,
  type BrowserScreencastClientFrame,
  type BrowserScreencastOpenRequest,
  type BrowserScreencastServerFrameV22,
} from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  projectBrowserScreencastOpenRequestToV10,
  subscribeAtScopeAddressedBrowserVersion,
} from "./browser-contracts-v1-bridge";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface BrowserScreencastStreamCallbacks {
  /**
   * `jpegBytes` is the paired binary WS frame for a `frame` kind and null for
   * every text kind. Delivered as a separate parameter for the same reason
   * `TerminalStreamClient` does it: the payload arrives out-of-band, not as a
   * field on the envelope.
   *
   * Acking is deliberately the consumer's job - the host gates the next frame
   * on it, and a tile acks after paint while a PiP mirror acks on arrival.
   */
  readonly onServerFrame: (
    frame: BrowserScreencastServerFrameV22,
    jpegBytes: Uint8Array | null,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

/**
 * The client frames `browser.screencast@2.2` added.
 *
 * A pre-2.2 host warn-drops a client frame it has no arm for and answers
 * nothing - screencast client frames are all fire-and-forget, so there is not
 * even a malformed-frame reply - which turns a long press or a zoom into a
 * request that waits forever. Dropping it locally makes it a no-op instead.
 */
const BROWSER_SCREENCAST_MINOR_2_CLIENT_KINDS: ReadonlySet<
  BrowserScreencastClientFrame["kind"]
> = new Set<BrowserScreencastClientFrame["kind"]>([
  "describePoint",
  "selectAt",
  "expandSelection",
  "readSelection",
  "clearSelection",
  "blurEditable",
  "setZoom",
]);

export type BrowserScreencastStreamClientOptions =
  BrowserScreencastOpenRequest & {
    readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
    readonly callbacks: BrowserScreencastStreamCallbacks;
  };

/**
 * Typed wrapper over one `browser.screencast` subscription - a
 * scope-authorized, tab-addressed media stream for a single viewer.
 *
 * The frozen @1 and @2.0 lines share frames; @2.1 also reports the logical
 * viewport for padded video capture, and @2.2 adds the page-signal frames and
 * `refused`. Server frames are parsed with the NEWEST union whatever was
 * negotiated - a 2.2 union parses a 2.0/2.1 payload unchanged, while the 2.1
 * union rejects every added 2.2 field outright and would drop the whole
 * refusal UX with a console warning. What has to respect the negotiated minor
 * is EMISSION, below.
 *
 * Epic requests are projected per negotiated session. Independent requests
 * negotiate the newest scope-addressed minor; a @1 host refuses their strict
 * scope-shaped params rather than serving another inventory.
 */
export class BrowserScreencastStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: BrowserScreencastStreamCallbacks;
  private closed: boolean;

  constructor(options: BrowserScreencastStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = openScreencastSubscription(wsStreamClient, openRequest);
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendClientFrame(frame: BrowserScreencastClientFrame): void {
    if (this.closed) return;
    const version = this.session.getNegotiatedSchemaVersion();
    if (
      frame.kind === "viewport" &&
      version !== null &&
      (version.major > 2 || (version.major === 2 && version.minor >= 1))
    )
      return;
    if (
      BROWSER_SCREENCAST_MINOR_2_CLIENT_KINDS.has(frame.kind) &&
      !this.supportsMinor2()
    ) {
      return;
    }
    this.session.sendClientFrame(frame, null);
  }

  /**
   * Whether this session negotiated `@2.2` or newer, which is what decides
   * whether a 2.2 client frame may be emitted at all. `null` - the handshake
   * has not settled - reads as "no": the transport drops an outbound frame
   * before the session is subscribed anyway, so nothing is lost by refusing
   * one here.
   */
  private supportsMinor2(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    if (version === null) return false;
    return version.major > 2 || (version.major === 2 && version.minor >= 2);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    const parsed = browserScreencastServerFrameV22Schema.safeParse(envelope);
    if (!parsed.success) {
      // Issue paths only - a `dialogOpened` frame carries page-authored text
      // and `navState` carries the visited URL.
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] browser.screencast frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    this.callbacks.onServerFrame(parsed.data, binaryPayload);
  }
}

function openScreencastSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: BrowserScreencastOpenRequest,
): IStreamSession {
  const scope = request.scope;
  if (scope.kind === "independent") {
    return subscribeAtScopeAddressedBrowserVersion(
      wsStreamClient,
      "browser.screencast",
      request,
    );
  }
  const epicId = scope.epicId;
  // Re-read at every wire subscribe: the major belongs to the CONNECTION, and a
  // reconnect can land on a host incarnation that serves the other one.
  return wsStreamClient.subscribeWithParamsProvider(
    "browser.screencast",
    (onWireVersion) =>
      onWireVersion?.major === 1
        ? projectBrowserScreencastOpenRequestToV10(request, epicId)
        : request,
  );
}
