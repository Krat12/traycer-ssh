import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { WelcomeTileModel } from "@/components/onboarding/welcome/welcome-providers-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

export const WELCOME_LAST_ENABLED_TOOLTIP =
  "At least one provider must stay enabled.";

/** Tone for the badge and the subtitle; the two share a palette. */
function toneClassName(good: boolean): string {
  return good ? "text-emerald-400/90" : "text-muted-foreground/60";
}

export interface WelcomeProviderTileProps {
  readonly model: WelcomeTileModel;
  /** The switch would turn off the last enabled provider (page-level guard). */
  readonly disablingLastEnabled: boolean;
  /** The shared `providers.setEnabled` mutation is in flight. */
  readonly settingEnabled: boolean;
  /** The element tooltips must stay inside - the dialog's content. */
  readonly collisionBoundary: Element | null;
  readonly onSetEnabled: (providerId: ProviderId, enabled: boolean) => void;
  /** Full-size tile in the grid, or a compact row in the disclosure. */
  readonly layout: "tile" | "row";
}

/**
 * One provider on page 1: identity (icon, name, install badge), the account
 * line when the host has one, and the enable switch.
 *
 * Dimming touches the identity pieces only, never the switch: a wrapper
 * opacity would take the control down with them, and the switch on a dimmed
 * row is precisely the thing the user is here to press (same reasoning as
 * `provider-list.tsx`).
 *
 * Two tooltips, two questions. The TILE's explains the state ("Install X on
 * this machine", "Not signed in"); the SWITCH's explains the one refusal
 * the page makes ("At least one provider must stay enabled") - on a guard
 * span, because a disabled control emits no pointer events.
 */
export function WelcomeProviderTile(
  props: WelcomeProviderTileProps,
): ReactNode {
  const {
    model,
    disablingLastEnabled,
    settingEnabled,
    collisionBoundary,
    onSetEnabled,
    layout,
  } = props;
  const installed = model.install === "detected" || model.install === "builtIn";
  const switchDisabled =
    model.switchDisabled || settingEnabled || disablingLastEnabled;
  // The state tooltip hangs on the identity block, not the whole tile, so it
  // never opens on top of the switch's own guard tooltip: two triggers
  // nested one inside the other would both answer a hover over the switch.
  const identity = (
    <TooltipWrapper
      label={model.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
      collisionBoundary={collisionBoundary}
    >
      <div
        data-testid="welcome-provider-identity"
        className="flex min-w-0 flex-1 items-center gap-2.5"
      >
        <HarnessIcon
          harnessId={providerIdToGuiHarnessId(model.providerId)}
          // Opacity as well as color: brand icons paint their own colors and
          // ignore `currentColor`, so a dimmed label next to a vivid logo
          // reads as two different rows.
          className={cn(
            layout === "tile" ? "size-6" : "size-4",
            model.dimmed && "opacity-60",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-ui-sm font-medium text-foreground",
            model.dimmed && "opacity-60",
          )}
        >
          {model.name}
        </span>
        <span
          data-testid="welcome-provider-badge"
          className={cn(
            "shrink-0 font-mono text-overline uppercase tracking-wider",
            toneClassName(installed),
            model.dimmed && "opacity-60",
          )}
        >
          {model.badge}
        </span>
      </div>
    </TooltipWrapper>
  );
  const control = (
    <TooltipWrapper
      label={disablingLastEnabled ? WELCOME_LAST_ENABLED_TOOLTIP : null}
      side="top"
      sideOffset={undefined}
      align={undefined}
      collisionBoundary={collisionBoundary}
    >
      {/* Guard span: the Switch is `disabled` in exactly the state this
          explains, and a disabled control emits no pointer events. */}
      <span className="ml-auto inline-flex shrink-0">
        <Switch
          checked={model.enabled}
          disabled={switchDisabled}
          aria-label={`Enable ${model.name}`}
          onCheckedChange={(next) => {
            if (switchDisabled) return;
            onSetEnabled(model.providerId, next);
          }}
        />
      </span>
    </TooltipWrapper>
  );

  if (layout === "tile") {
    return (
      <li
        data-testid="welcome-provider-tile"
        data-provider-id={model.providerId}
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-foreground/[0.03] p-3.5"
      >
        <div className="flex min-w-0 items-center gap-3">
          {identity}
          {control}
        </div>
        {model.subtitle !== null ? (
          <p
            data-testid="welcome-provider-subtitle"
            className={cn(
              "min-w-0 truncate text-ui-xs",
              model.subtitleTone === "good"
                ? "text-emerald-400/90"
                : "text-muted-foreground",
            )}
          >
            {model.subtitle}
          </p>
        ) : null}
      </li>
    );
  }
  return (
    <li
      data-testid="welcome-provider-row"
      data-provider-id={model.providerId}
      className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5"
    >
      {identity}
      {control}
    </li>
  );
}
