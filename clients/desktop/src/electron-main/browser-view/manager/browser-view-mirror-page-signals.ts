/**
 * The page-signal half of a `browser.mirror` (D13, D14, D15), for a NATIVE tab.
 *
 * The headless twin is the host's `BrowserTabPageSignals`
 * (`traycer-host/src/domain/browser/runtime/browser-page-signals.ts`), and the
 * page-side halves are the SAME source strings for both
 * (`@traycer/protocol/host/browser/page-scripts`): the phone's keyboard,
 * long-press sheet and double-tap must not behave differently because the tab
 * happens to live in a `<webview>` rather than in a headless Chromium. A copy
 * of the script text here would be that fork, so nothing here inlines any.
 *
 * Everything that arrives from the page is untrusted - the binding payload and
 * every evaluate result - so all of it is parsed with the CONTRACT's own
 * bounded schemas. A hostile page that returned more than the wire parser
 * accepts would otherwise drop the whole frame instead of arriving truncated.
 *
 * It rides the guest's ONE shared `BrowserDebugSession`
 * (`sendCommand` / `onBindingCalled`), never a second `webContents.debugger`
 * client: the annotation overlay has a binding and a listener on that same
 * attachment and both must keep working while a mirror is live.
 */
import { z } from "zod";
import {
  browserEditableFocusFields,
  browserPointDescribedFields,
  BROWSER_SELECTION_TEXT_MAX,
} from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_DESCRIBE_POINT_GLOBAL,
  BROWSER_DESCRIBE_POINT_SCRIPT,
  BROWSER_EDITABLE_FOCUS_BINDING,
  BROWSER_EDITABLE_FOCUS_SCRIPT,
  BROWSER_SELECTION_GLOBAL,
  BROWSER_SELECTION_SCRIPT,
} from "@traycer/protocol/host/browser/page-scripts";
import type { BrowserMirrorServerFrame } from "@traycer/protocol/host/browser/mirror-contracts";
import { describeLogError, log } from "../../app/logger";
import { readEvaluateValue, recordValue } from "../guards";
import type { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserMirrorEventFrame } from "./browser-view-mirror-capture";

/**
 * The host -> desktop frames this serves. The other mirror server frames are the
 * pump's (`ack`, `setParams`) or the dialog's.
 */
export type BrowserMirrorPageSignalFrame = Extract<
  BrowserMirrorServerFrame,
  {
    readonly kind:
      | "describePoint"
      | "selectAt"
      | "expandSelection"
      | "readSelection"
      | "clearSelection"
      | "blurEditable"
      | "setZoom";
  }
>;

/**
 * How long one signal waits for the page before it is answered with nothing.
 * Same bound as the headless path, for the same reason: a page can wedge its
 * own main thread, and a long-press sheet with a spinner and no exit is worse
 * than an empty one.
 */
const PAGE_SIGNAL_TIMEOUT_MS = 5_000;

/**
 * The editable-focus payload is `{ focused, inputMode, multiline, rect }` and
 * nothing else, so anything past this is a page playing games with the binding
 * - dropped before `JSON.parse` rather than after.
 */
const MAX_EDITABLE_FOCUS_PAYLOAD_CHARS = 1_024;

/** Built from the contract's own field bundles, so the two cannot drift. */
const editableFocusPayloadSchema = z
  .object({ ...browserEditableFocusFields })
  .strict();

const describedPointSchema = z
  .object({ ...browserPointDescribedFields })
  .strict();

const selectionTextSchema = z.string().max(BROWSER_SELECTION_TEXT_MAX);

/** Installed on every document, in this order; all three are idempotent. */
const PAGE_SCRIPTS: readonly string[] = [
  BROWSER_EDITABLE_FOCUS_SCRIPT,
  BROWSER_DESCRIBE_POINT_SCRIPT,
  BROWSER_SELECTION_SCRIPT,
];

export interface BrowserViewMirrorPageSignalsInput {
  readonly debug: BrowserDebugSession;
  readonly guestKey: string;
  /** Onto the mirror's own stream, as an unsolicited or answered text frame. */
  readonly emit: (frame: BrowserMirrorEventFrame) => void;
  /**
   * A page scale actually changed. The capture re-mints its viewport epoch so
   * every viewer re-reads `metadata.pageScaleFactor` - the frames themselves
   * carry the new scale, but nothing else tells a viewer its hit testing needs
   * to be re-derived.
   */
  readonly onZoomApplied: () => void;
}

/**
 * One mirrored guest's page signals: installed with the mirror, removed with
 * it.
 *
 * Nothing here ever rejects, and the two request kinds that carry a
 * `requestId` are ALWAYS answered - with the empty answer when the page cannot
 * be read - because a phone waiting on one would otherwise wait forever.
 */
export class BrowserViewMirrorPageSignals {
  private readonly input: BrowserViewMirrorPageSignalsInput;
  private unsubscribeBinding: (() => void) | null = null;
  private scriptIds: string[] = [];
  private disposed = false;

  constructor(input: BrowserViewMirrorPageSignalsInput) {
    this.input = input;
  }

  /**
   * The listener FIRST, then the binding, then the scripts.
   *
   * The listener goes on before `Runtime.addBinding` and before the one-off
   * evaluate deliberately: the focus observer emits its first observation
   * inline as it installs, and a listener registered after that evaluate would
   * miss the focus state of an already-loaded page - which is exactly the state
   * a phone opening a viewer on a live tab is in.
   *
   * Called again after a debugger reattach: `resetDetachedState` clears the
   * session's enabled flag and the re-enable list is domains only, so neither
   * the binding nor the on-new-document registrations survive one.
   */
  async install(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.unsubscribeBinding === null) {
        this.unsubscribeBinding = this.input.debug.onBindingCalled((params) => {
          this.handleBindingCalled(params);
        });
      }
      // A second binding beside the annotation overlay's, not a replacement:
      // the session's `bindingCalled` fan-out serves both, and each listener
      // filters by name.
      await this.input.debug.sendCommand(
        "Runtime.addBinding",
        { name: BROWSER_EDITABLE_FOCUS_BINDING },
        undefined,
      );
      // Whatever the previous attachment registered went away with its target;
      // holding the stale identifiers would only make `dispose` remove scripts
      // that no longer exist.
      this.scriptIds = [];
      for (const source of PAGE_SCRIPTS) {
        const identifier =
          await this.input.debug.installScriptBeforeNavigation(source);
        if (this.disposed) return;
        this.scriptIds.push(identifier);
        // The registration above covers every FUTURE document; a tab that was
        // already loaded when its first viewer arrived needs this one.
        await this.evaluate(source);
        if (this.disposed) return;
      }
    } catch (error) {
      // A mirror whose signals could not be installed keeps its pixels: every
      // later request answers empty, which is the same outcome as a page that
      // does not answer.
      log.warn("[browser-view] mirror page signals could not be installed", {
        guestKey: this.input.guestKey,
        error: describeLogError(error),
      });
    }
  }

  /** Fire-and-forget: the answer, if there is one, leaves on the sink. */
  handle(frame: BrowserMirrorPageSignalFrame): void {
    void this.dispatch(frame);
  }

  /**
   * The scripts and the binding go with the last mirror of this tab. The
   * already-loaded document keeps its listeners, but with the binding gone
   * `window.__traycerEditableFocus` is no longer a function and the observer's
   * own guard makes each post a no-op.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBinding?.();
    this.unsubscribeBinding = null;
    const identifiers = this.scriptIds;
    this.scriptIds = [];
    if (!this.input.debug.isReady()) return;
    for (const identifier of identifiers) {
      void this.input.debug
        .removeScriptBeforeNavigation(identifier)
        .catch(() => undefined);
    }
    // By NAME, so the annotation overlay's binding on the same attachment is
    // untouched. Not through `send`, which refuses once disposed.
    void this.input.debug
      .sendCommand(
        "Runtime.removeBinding",
        { name: BROWSER_EDITABLE_FOCUS_BINDING },
        undefined,
      )
      .catch(() => undefined);
  }

  private async dispatch(frame: BrowserMirrorPageSignalFrame): Promise<void> {
    switch (frame.kind) {
      case "describePoint": {
        const parsed = describedPointSchema.safeParse(
          await this.withDeadline(
            this.evaluate(
              `window.${BROWSER_DESCRIBE_POINT_GLOBAL}(${cssPx(frame.x)}, ${cssPx(frame.y)})`,
            ),
            null,
          ),
        );
        // A point with nothing on it and a page that answered nothing
        // parseable are the same answer: an empty sheet, never a spinner.
        const point = parsed.success
          ? parsed.data
          : { link: null, image: null, text: null };
        this.input.emit({
          kind: "pointDescribed",
          hasBinaryPayload: false,
          subscriberId: frame.subscriberId,
          requestId: frame.requestId,
          ...point,
        });
        return;
      }
      case "selectAt":
        await this.withDeadline(
          this.evaluate(
            `window.${BROWSER_SELECTION_GLOBAL}.selectAt(${cssPx(frame.x)}, ${cssPx(frame.y)})`,
          ),
          null,
        );
        return;
      case "expandSelection":
        // The unit is a closed vocabulary on the wire; quoted anyway, because
        // an expression built by concatenation is the wrong place to rely on
        // that.
        await this.withDeadline(
          this.evaluate(
            `window.${BROWSER_SELECTION_GLOBAL}.expand(${JSON.stringify(frame.unit)})`,
          ),
          null,
        );
        return;
      case "readSelection": {
        const parsed = selectionTextSchema.safeParse(
          await this.withDeadline(
            this.evaluate(`window.${BROWSER_SELECTION_GLOBAL}.read()`),
            null,
          ),
        );
        this.input.emit({
          kind: "selectionText",
          hasBinaryPayload: false,
          subscriberId: frame.subscriberId,
          requestId: frame.requestId,
          text: parsed.success ? parsed.data : "",
        });
        return;
      }
      case "clearSelection":
        await this.withDeadline(
          this.evaluate(`window.${BROWSER_SELECTION_GLOBAL}.clear()`),
          null,
        );
        return;
      case "blurEditable":
        await this.withDeadline(
          this.evaluate("document.activeElement?.blur?.()"),
          null,
        );
        return;
      case "setZoom": {
        // Visual (pinch) scale, NOT `webContents.setZoomFactor`: that one is
        // the desktop user's own layout zoom, so it would reflow the page every
        // viewer is looking at and change the local tile's chrome instead of
        // the scale the phone asked for.
        const answered = await this.withDeadline(
          this.send("Emulation.setPageScaleFactor", {
            pageScaleFactor: frame.factor,
          }),
          null,
        );
        if (answered === null) return;
        this.input.onZoomApplied();
        return;
      }
    }
  }

  /** The evaluated value, or `null` for anything that did not answer. */
  private async evaluate(expression: string): Promise<unknown> {
    return readEvaluateValue(
      await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: false,
      }),
    );
  }

  /** The reply record, or `null` when the command did not land. */
  private async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (this.disposed) return null;
    try {
      return recordValue(
        await this.input.debug.sendCommand(method, params, undefined),
      );
    } catch (error) {
      // Ordinary on a guest that navigated or detached under a request in
      // flight: a page signal is never the thing that fails a mirror.
      log.debug("[browser-view] mirror page signal command failed", {
        guestKey: this.input.guestKey,
        method,
        error: describeLogError(error),
      });
      return null;
    }
  }

  private handleBindingCalled(params: Record<string, unknown>): void {
    if (this.disposed) return;
    if (params.name !== BROWSER_EDITABLE_FOCUS_BINDING) return;
    const payload = params.payload;
    if (
      typeof payload !== "string" ||
      payload.length > MAX_EDITABLE_FOCUS_PAYLOAD_CHARS
    ) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = editableFocusPayloadSchema.safeParse(decoded);
    if (!parsed.success) return;
    this.input.emit({
      kind: "editableFocus",
      hasBinaryPayload: false,
      // Unsolicited: nobody asked, so there is no subscriber to echo. An id the
      // host does not know means every subscriber of this tab (T07).
      subscriberId: "",
      ...parsed.data,
    });
  }

  private withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        resolve(fallback);
      }, PAGE_SIGNAL_TIMEOUT_MS);
      timer.unref();
      const settle = (value: T): void => {
        clearTimeout(timer);
        resolve(value);
      };
      void work.then(settle, () => {
        settle(fallback);
      });
    });
  }
}

/**
 * A coordinate on its way into an evaluated expression. Already page CSS pixels
 * (the host resolved the normalized point against the requesting subscriber's
 * presented frame), and rounded to hundredths so the expression stays short and
 * never carries an exponent.
 */
function cssPx(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}
