import { Copy, Expand, ExternalLink, Link2, Share2 } from "lucide-react";
import { toast } from "sonner";
import type { ReactElement } from "react";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { parseHttpUrl } from "@/lib/browser-view/browser-tab-display";
import type { ScreencastContextMenu } from "@/lib/browser-view/sessions/use-screencast-session";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * The long press's answer as a bottom sheet (D14) - the context menu a finger
 * expects, on the one shell that has no right click.
 *
 * Every datum here came from the HOST's hit test of the page, so nothing in this
 * file inspects pixels or guesses at text. The two selection rows act on the
 * page's live selection through the session rather than on a string they hold,
 * which is what lets "Copy text" follow a "Select more" instead of collapsing it.
 */
export function BrowserPeekContextSheet(props: {
  readonly menu: ScreencastContextMenu;
  /** The host and session the pressed tab belongs to - a new tab joins them. */
  readonly hostId: string;
  readonly sessionId: string;
}) {
  const { menu } = props;
  const sessions = useMaybeBrowserSessionsContext();
  const openLink = useOpenLink();
  const { copy } = useClipboardCopy({
    resetMs: 1_500,
    onSuccess: () => {
      toast.success("Copied");
    },
    onError: () => {
      toast.error("Couldn't copy to the clipboard.");
    },
  });

  const openInNewTab = (url: string): void => {
    if (
      sessions === null ||
      sessions.lifecycle !== "live" ||
      sessions.hostId !== props.hostId
    ) {
      toast.error(browserSessionsRefusal(sessions));
      return;
    }
    menu.close();
    // A tab of THIS session, the way a popup from the page would be - same
    // profile, same jar - and the surface listing the session picks it up.
    void sessions.openTab(props.sessionId, url).catch((cause: unknown) => {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Couldn't open the browser tab.",
      );
    });
  };

  const share = (url: string): void => {
    menu.close();
    if (canShare()) {
      // A dismissed share sheet rejects exactly like a failed one, and a person
      // changing their mind is not an error worth a toast.
      void navigator.share({ url }).catch(() => undefined);
      return;
    }
    // Deliberately external: the row IS "take this out of the app", so it must
    // not be re-routed in-app by the link setting.
    void openLink(url, "app", null);
  };

  const rows: ReactElement[] = [];
  if (menu.link !== null) {
    const link = menu.link;
    rows.push(
      <ContextSheetRow
        key="open-tab"
        label="Open in new tab"
        icon={<ExternalLink className="size-4" aria-hidden />}
        onSelect={() => openInNewTab(link)}
      />,
      <ContextSheetRow
        key="share"
        label={canShare() ? "Share…" : "Open in browser"}
        icon={<Share2 className="size-4" aria-hidden />}
        onSelect={() => share(link)}
      />,
      <ContextSheetRow
        key="copy-link"
        label="Copy link"
        icon={<Link2 className="size-4" aria-hidden />}
        onSelect={() => {
          menu.close();
          copy(link);
        }}
      />,
    );
  }
  if (menu.image !== null) {
    const image = menu.image;
    rows.push(
      <ContextSheetRow
        key="copy-image"
        label="Copy image address"
        icon={<Copy className="size-4" aria-hidden />}
        onSelect={() => {
          menu.close();
          copy(image);
        }}
      />,
    );
  }
  if (menu.text !== null) {
    rows.push(
      <ContextSheetRow
        key="copy-text"
        label="Copy text"
        icon={<Copy className="size-4" aria-hidden />}
        onSelect={() => {
          // The read is in flight when the sheet goes; the session keeps it and
          // writes the clipboard on the host's answer.
          menu.copySelection();
          menu.close();
        }}
      />,
    );
    if (menu.nextExpandUnit !== null) {
      rows.push(
        <ContextSheetRow
          key="select-more"
          label="Select more"
          icon={<Expand className="size-4" aria-hidden />}
          onSelect={menu.expandSelection}
        />,
      );
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (open) return;
        menu.close();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="pb-safe-bottom"
      >
        <SheetHeader>
          <SheetTitle>{contextSheetTitle(menu)}</SheetTitle>
          {/* Truncated by CSS, never by slicing the string: a URL cut in code is
              a URL the reader cannot check. */}
          {menu.link === null ? null : (
            <SheetDescription className="truncate">
              {menu.link}
            </SheetDescription>
          )}
          {menu.selection === null ? null : (
            <SheetDescription className="line-clamp-3 break-words text-foreground">
              {menu.selection}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="flex flex-col px-2 pb-2">{rows}</div>
      </SheetContent>
    </Sheet>
  );
}

function ContextSheetRow(props: {
  readonly label: string;
  readonly icon: ReactElement;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      // A finger's row height, not a layout size.
      className="h-12 justify-start gap-3 px-3 text-ui-sm"
      onClick={props.onSelect}
    >
      {props.icon}
      {props.label}
    </Button>
  );
}

/** The link's host, else what the point actually was. */
function contextSheetTitle(menu: ScreencastContextMenu): string {
  if (menu.link !== null) return parseHttpUrl(menu.link)?.host ?? menu.link;
  return menu.text !== null ? "Selected text" : "Image";
}

/**
 * Whether the shell has an OS share sheet. iOS in a Capacitor WebView does;
 * desktop Electron and most desktop browsers do not, and there the row opens the
 * default browser instead.
 */
function canShare(): boolean {
  return typeof navigator.share === "function";
}
