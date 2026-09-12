import { useBrowserViewport } from "./use-browser-viewport";
import { BrowserViewportToolbar } from "./browser-viewport-toolbar";
import { BrowserViewportFrame } from "./browser-viewport-frame";
import { useLayoutEffect, useMemo, useState, type ReactElement } from "react";
import { AlertTriangle, Monitor, Pause, Radio, WifiOff } from "lucide-react";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import {
  BrowserTileToolbar,
  BrowserTileToolbarCompact,
  type BrowserPictureInPictureControl,
} from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "./browser-start-page";
import { BrowserPeekContextSheet } from "./browser-peek-context-sheet";
import type { BrowserTileNode } from "./browser-tile-placement";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import { ScreencastSurface } from "@/components/epic-canvas/renderers/screencast-surface";
import { useScreencastTileChrome } from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import {
  browserPeekFrameKey,
  snapshotVideoFrameIntoPeekCache,
  useRetainLastBrowserPeekFrame,
} from "@/lib/browser-view/sessions/peek-frame-cache";
import {
  useScreencastSession,
  type ScreencastDialog,
  type ScreencastLifecycle,
  type ScreencastSession,
} from "@/lib/browser-view/sessions/use-screencast-session";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { cn } from "@/lib/utils";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import { browserRefusalMessage } from "@/lib/browser-view/sessions/browser-refusal-copy";
import { DEFAULT_BROWSER_TILE_URL } from "@/lib/browser-view/browser-tile-defaults";

/**
 * `touch-none`: the controller translates a finger drag into wheel frames
 * itself, and it can only see the moves the browser does not consume for its
 * own panning and pinch-zoom. Touch-action governs touch and pen alone, so a
 * mouse is unaffected.
 */
const SCREENCAST_SURFACE_CLASS =
  "absolute inset-0 h-full w-full cursor-default touch-none overflow-hidden bg-background p-0 text-left outline-none";

interface BrowserPeekStatus {
  readonly label: string;
  readonly overlay: string | null;
  readonly tone: "live" | "muted" | "bad";
  readonly Icon: typeof Radio;
}

export type BrowserPeekNode = Pick<
  BrowserTileNode,
  "instanceId" | "hostId" | "sessionId" | "tabId"
> & {
  readonly initialUrl: string;
};

/**
 * What the host's `complete` frame means for this tile. The host answers it for
 * every Electron-placed tab (`browser-screencast-plane.ts`'s
 * `subscribeScreencast`), because such a tab has no viewer plane there - so the
 * frame alone cannot say whether pixels are about to appear somewhere else on
 * this screen or will never appear here at all.
 *
 * - `ended` - an ordinary cast that stopped.
 * - `native-handoff` - this client is the one placing the native tab, so its
 *   own window is a beat away from showing the page.
 * - `native-elsewhere` - the tab is live in the desktop app on that host. No
 *   longer terminal copy of its own: that desktop mirrors its native tabs to
 *   remote viewers, so the frame is an ordinary end that the resubscribe
 *   ladder re-opens (D04, D20) - and a desktop that cannot mirror answers
 *   `refused`, which says which remedy on which machine.
 */
export type BrowserPeekCompleteMeaning =
  | "ended"
  | "native-handoff"
  | "native-elsewhere";

interface BrowserPeekTileProps {
  readonly scope: HostResourceScope;
  readonly node: BrowserPeekNode;
  /** Whether the tile body is actually on screen, not merely mounted. */
  readonly visible: boolean;
  /**
   * No `onRequestClose` here on purpose: the streamed VIEWER never retires its
   * own tile. The body owns that decision, and the picture-in-picture handoff
   * - the one path that used to close from here - closes from the adapter that
   * starts it. `onRequestCloseTab` below is not a way back in: it does not
   * retire this tile, it hands one chord to a surface that owns its row's
   * close, and the viewer that owns none passes `null`.
   */
  readonly onConvertToPip: (() => void) | null;
  /**
   * What `mod+t` means here, or `null` where the chord belongs to the page.
   *
   * Unlike `onRequestClose` above this one is NOT withheld: it does not retire
   * the tile, it asks the surface hosting it to open a tab - the streamed twin
   * of the `newTab` row a native tile gets from main's reserved-chord table.
   * The canvas passes `null` all the way down, so a canvas tile claims nothing.
   */
  readonly onRequestNewTab: (() => void) | null;
  /**
   * What `mod+w` means here, or `null` where the chord belongs to the page.
   *
   * The `closeTab` row's streamed half, non-null for exactly the surface that
   * OWNS its row's close - the Start Page panel, whose close is tombstone-first
   * and retires a row whose device may not even be reachable. The canvas passes
   * `null` and keeps the deliberate omission above intact: nothing here can
   * retire a canvas viewer's tile.
   */
  readonly onRequestCloseTab: (() => void) | null;
  readonly completeMeans: BrowserPeekCompleteMeaning;
}

/**
 * The streamed browser viewer, for both pointer grades (decision #13).
 *
 * The transport, arm/epoch protocol, viewport bridge and nav-state derivation
 * are device-agnostic, and so is the input path: the controller translates a
 * finger into scroll and tap frames itself, keyed off `pointerType`. What
 * `useCoarsePointer()` picks is the chrome and the dialog containers a finger
 * can actually reach.
 */
export function BrowserPeekTile(props: BrowserPeekTileProps) {
  const { node, visible } = props;
  const coarsePointer = useCoarsePointer();
  const hostEntry = useHostDirectoryEntry(node.hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(hostEntry, auth);
  useRegisterVisibleBrowserTile({
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
  });
  const frameCacheKey = browserPeekFrameKey(node);
  // The sessions inventory this tile's host publishes: the profile the
  // toolbar describes, and whether the tab is still listed at all - the
  // resubscribe ladder's stop condition (D20). "Not listed yet" reads as
  // listed, so a sessions reconnect (which empties `items` until its next
  // snapshot) does not cancel a ladder mid-outage.
  const browserSessions = useMaybeBrowserSessionsContext();
  const sessionInfo = browserSessions?.items.find(
    (item) => item.sessionId === node.sessionId,
  );
  const tabStillListed =
    browserSessions?.inventoryReady !== true ||
    sessionInfo?.tabs.some((item) => item.tabId === node.tabId) === true;
  const session = useScreencastSession({
    client,
    scope: props.scope,
    onRequestNewTab: props.onRequestNewTab,
    onRequestCloseTab: props.onRequestCloseTab,
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
    tabStillListed,
    captureDormantSnapshot: (video, wasActivePlane) => {
      snapshotVideoFrameIntoPeekCache(frameCacheKey, video, wasActivePlane);
    },
  });
  // A peeked session can be isolated too; the toolbar has to say so rather
  // than describe saved logins that this session never had.
  const sessionProfile = sessionInfo?.profile ?? "primary";
  const { image, navState, armedEpoch, dialog } = session;
  const viewport = useBrowserViewport({
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    instanceId: node.instanceId,
    visible,
    disabled: client === null,
    pageZoom: 1,
    native: false,
    registrationId: null,
  });
  const { tileRef, viewportRef } = session.refs;
  useRetainLastBrowserPeekFrame(frameCacheKey, image);
  const inputOwnerId =
    armedEpoch === null
      ? null
      : compositeKey(node.hostId, node.sessionId, node.tabId, node.instanceId);

  // `releaseForwardedPageKeys` is published with the claim rather than looked
  // up later: the keybinding provider fires app-forwarded actions while a tile
  // is armed, and the only tile it may ever tell about that is the one holding
  // the claim it read.
  const releaseForwardedPageKeys = session.releaseForwardedPageKeys;
  useLayoutEffect(() => {
    if (inputOwnerId === null) return;
    const store = useScreencastArmedStore.getState();
    store.claim(inputOwnerId, releaseForwardedPageKeys);
    return () => {
      useScreencastArmedStore.getState().release(inputOwnerId);
    };
  }, [inputOwnerId, releaseForwardedPageKeys]);

  const status = useMemo(
    () =>
      browserPeekStatus({
        lifecycle: session.lifecycle,
        visible,
        details: session.details,
        completeMeans: props.completeMeans,
        hostId: node.hostId,
      }),
    [
      session.details,
      session.lifecycle,
      visible,
      props.completeMeans,
      node.hostId,
    ],
  );

  const chrome = useScreencastTileChrome({
    profile: sessionProfile,
    navState,
    initialUrl: node.initialUrl,
    disabled: client === null,
    onNavigateUrl: (url) => {
      session.requestNav({ kind: "navigate", url });
    },
    onBack: () => {
      session.requestNav({ kind: "goBack" });
    },
    onForward: () => {
      session.requestNav({ kind: "goForward" });
    },
    onReload: () => {
      session.requestNav({ kind: "reload" });
    },
  });

  // Focus in the address field must also drop any page keys still forwarded to
  // the screencast, so typing a URL does not reach the remote page.
  const controller: TileController = {
    ...chrome.controller,
    viewport: viewport.controller,
    onAddressFocusChange: (focused: boolean) => {
      if (focused) session.releaseForwardedPageKeys();
      chrome.onAddressFocusChange(focused);
    },
  };
  const showStartPage = chrome.controller.url === DEFAULT_BROWSER_TILE_URL;

  return (
    // No keyboard inset of its own (D13, critique-2 B20). The iOS keyboard
    // overlays the webview (`Keyboard.resize: None`), but the app shell sizes
    // through `h-safe-dvh`, which already subtracts `--keyboard-inset` - so the
    // pane this tile fills shrinks on its own, the viewport `ResizeObserver`
    // reports the smaller box, and the host reflows the page. Padding here as
    // well would subtract the keyboard TWICE (the same trap
    // `mobile-epic-tile-view.tsx` documents).
    <div
      ref={tileRef}
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      onPointerDownCapture={viewport.onInteraction}
      onFocusCapture={viewport.onInteraction}
      onKeyDownCapture={viewport.onInteraction}
      data-testid={`browser-peek-tile-${node.instanceId}`}
    >
      {coarsePointer ? (
        <BrowserTileToolbarCompact
          controller={controller}
          loading={navState.loading}
        />
      ) : (
        <ScreencastPeekChromeBar
          controller={controller}
          pictureInPicture={{
            // Both halves of today's gate: a placement with nowhere to put a
            // picture-in-picture window supplies no callback, and a tile with
            // no stream client cannot hand one off either.
            disabled: props.onConvertToPip === null || client === null,
            convert: () => props.onConvertToPip?.(),
          }}
          loading={navState.loading}
          armed={armedEpoch !== null}
          status={status}
          onRelease={session.disarm}
        />
      )}
      <BrowserViewportToolbar controller={viewport.controller} />
      <BrowserViewportFrame viewport={viewport} surfaceRef={null}>
        <div
          ref={viewportRef}
          className={cn(
            "relative h-full w-full min-h-0 cursor-default overflow-hidden bg-background p-0 text-left outline-none",
            armedEpoch !== null && "ring-2 ring-primary ring-inset",
          )}
        >
          {showStartPage ? (
            <BrowserStartPage
              scope={props.scope}
              hostId={node.hostId}
              browserRunsOnHost
              visible={visible}
              onNavigate={chrome.navigateToUrl}
            />
          ) : null}
          <ScreencastPeekSurface
            session={session}
            overlay={status.overlay}
            showStartPage={showStartPage}
          />
          {showStartPage || dialog === null ? null : (
            <BrowserDialogOverlay
              key={dialog.generation}
              dialog={dialog}
              sheet={coarsePointer}
              onRespond={session.respondToDialog}
            />
          )}
          {/* The long-press sheet (D14). No pointer-grade gate of its own: only
              the installed mobile app arms the gesture, so a menu existing at
              all is already the answer. */}
          {session.contextMenu === null ? null : (
            <BrowserPeekContextSheet
              menu={session.contextMenu}
              hostId={node.hostId}
              sessionId={node.sessionId}
            />
          )}
        </div>
      </BrowserViewportFrame>
    </div>
  );
}

/** The pixels and everything that reaches them. */
function ScreencastPeekSurface(props: {
  readonly session: ScreencastSession;
  readonly overlay: string | null;
  readonly showStartPage: boolean;
}) {
  const session = props.session;
  const { overlayButtonRef, imeInputRef } = session.refs;
  const frameSize = session.frameSize;
  const pixels = (
    <>
      <ScreencastSurface session={session} />
      {props.overlay === null ? null : (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded border border-border bg-popover/95 px-3 py-2 text-ui-sm text-popover-foreground shadow-sm">
          {props.overlay}
        </div>
      )}
      {import.meta.env.DEV && frameSize !== null ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/80 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
          {frameSize.width} x {frameSize.height}
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <button
        ref={overlayButtonRef}
        type="button"
        hidden={props.showStartPage}
        className={SCREENCAST_SURFACE_CLASS}
        aria-label="Browser screencast controls"
        {...session.overlayHandlers}
      >
        {pixels}
      </button>
      <input
        ref={imeInputRef}
        aria-label="Browser IME input"
        autoComplete="off"
        disabled={props.showStartPage}
        className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
        {...session.imeHandlers}
      />
      {!props.showStartPage && session.composing ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute right-3 top-3 rounded-sm bg-background/90 px-2 py-1 text-ui-xs text-muted-foreground"
        >
          Composing text…
        </div>
      ) : null}
    </>
  );
}

function ScreencastPeekChromeBar(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl;
  readonly loading: boolean;
  readonly armed: boolean;
  readonly status: BrowserPeekStatus;
  readonly onRelease: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col border-b border-border">
      <div className="flex min-h-0 items-center">
        <div className="min-w-0 flex-1 [&>div]:border-b-0">
          <BrowserTileToolbar
            controller={props.controller}
            loading={props.loading}
            pictureInPicture={props.pictureInPicture}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pr-2">
          {props.armed ? (
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant="outline">Controlling</Badge>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Release control"
                onClick={props.onRelease}
              >
                Release
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-ui-xs",
              peekStatusToneClass(props.status.tone),
            )}
          >
            <props.status.Icon className="size-3.5" aria-hidden />
            <span>{props.status.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One dialog body, two containers: a bottom sheet where a finger has to reach
 * the buttons, the tile-local `<dialog>` otherwise. A backdrop dismiss has no
 * button to read intent from - an alert has only one action (OK), so the
 * dismiss is that; confirm/prompt read it as Cancel, exactly as Escape does
 * for `window.confirm()`/`window.prompt()` on a real page.
 */
function BrowserDialogOverlay(props: {
  readonly dialog: ScreencastDialog;
  readonly sheet: boolean;
  readonly onRespond: (
    generation: number,
    accept: boolean,
    promptText: string | null,
  ) => void;
}) {
  const [promptText, setPromptText] = useState(props.dialog.defaultValue);
  const isAlert = props.dialog.type === "alert";
  const isPrompt = props.dialog.type === "prompt";
  let title = "Confirm";
  if (isAlert) title = "Alert";
  else if (isPrompt) title = "Prompt";
  const respond = (accept: boolean): void => {
    props.onRespond(
      props.dialog.generation,
      accept,
      accept && isPrompt ? promptText : null,
    );
  };
  const promptInput = (className: string): ReactElement | null =>
    isPrompt ? (
      <input
        aria-label="Prompt response"
        className={cn(
          "rounded border border-input bg-background px-3 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        value={promptText}
        onChange={(event) => setPromptText(event.currentTarget.value)}
      />
    ) : null;
  const actions = (
    <>
      {isAlert ? null : (
        <Button type="button" variant="ghost" onClick={() => respond(false)}>
          Cancel
        </Button>
      )}
      <Button type="button" onClick={() => respond(true)}>
        OK
      </Button>
    </>
  );

  if (props.sheet) {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (open) return;
          respond(isAlert);
        }}
      >
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="pb-safe-bottom"
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="whitespace-pre-wrap break-words text-foreground">
              {props.dialog.message}
            </SheetDescription>
          </SheetHeader>
          {promptInput("mx-4 w-auto")}
          <SheetFooter className="flex-row justify-end gap-2">
            {actions}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <dialog
      open
      aria-label={`${props.dialog.type} dialog`}
      aria-modal="true"
      className="absolute inset-0 z-10 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-background/60 p-4 text-foreground"
    >
      <div className="w-full max-w-md rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg">
        <div className="text-ui-base font-medium">{title}</div>
        <div className="mt-2 whitespace-pre-wrap break-words text-ui-sm">
          {props.dialog.message}
        </div>
        {promptInput("mt-3 w-full")}
        <div className="mt-4 flex justify-end gap-2">{actions}</div>
      </div>
    </dialog>
  );
}

function peekStatusToneClass(tone: BrowserPeekStatus["tone"]): string {
  if (tone === "live") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "bad") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-foreground/8 text-muted-foreground";
}

function browserPeekStatus(input: {
  readonly lifecycle: ScreencastLifecycle;
  readonly visible: boolean;
  readonly details: string | null;
  readonly completeMeans: BrowserPeekCompleteMeaning;
  readonly hostId: string;
}): BrowserPeekStatus {
  const { lifecycle, visible, details, completeMeans, hostId } = input;
  if (!visible) {
    return {
      label: "Paused off-screen",
      overlay: "Peek is paused while this tile is hidden.",
      tone: "muted",
      Icon: Pause,
    };
  }
  if (lifecycle === "live") {
    return { label: "Live", overlay: null, tone: "live", Icon: Radio };
  }
  if (lifecycle === "idle") {
    return {
      label: "Live idle",
      overlay: details,
      tone: "muted",
      Icon: Radio,
    };
  }
  if (lifecycle === "refused") {
    // Terminal until something changes on the host, so it says which thing
    // and on which machine (D06) rather than spinning on a retry the hook
    // deliberately does not schedule for a refusal.
    return {
      label: "Unavailable",
      overlay: details === null ? null : browserRefusalMessage(details, hostId),
      tone: "bad",
      Icon: Monitor,
    };
  }
  if (lifecycle === "failed" || lifecycle === "disconnected") {
    return {
      label: "Disconnected",
      overlay: details ?? "Screencast is disconnected.",
      tone: "bad",
      Icon: WifiOff,
    };
  }
  if (lifecycle === "complete") {
    // An Electron wake's `complete` frame means "attached, going native", not
    // a dead cast (`browser-screencast-plane.ts`'s `subscribeScreencast`) -
    // WifiOff/"Ended" would read as a failure at the exact moment the tab is
    // succeeding.
    if (completeMeans === "native-handoff") {
      return {
        label: "Going native",
        overlay: "Handing off to the native tab.",
        tone: "muted",
        Icon: Radio,
      };
    }
    return {
      label: "Ended",
      overlay: details,
      tone: "muted",
      Icon: WifiOff,
    };
  }
  if (lifecycle === "stale") {
    return {
      label: "Stale",
      overlay: details ?? "No new frames have arrived recently.",
      tone: "muted",
      Icon: AlertTriangle,
    };
  }
  return {
    label: "Connecting",
    overlay: details,
    tone: "muted",
    Icon: Radio,
  };
}
