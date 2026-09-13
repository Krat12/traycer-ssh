import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";
import { TRAYCER_GITHUB_URL } from "@/lib/onboarding-links";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useOnboardingFlowStore,
  type ChainStatus,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  selectOnboardingBusy,
  useOnboardingPresenceStore,
} from "@/stores/onboarding/onboarding-presence-store";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";
import {
  getSystemTabModalApi,
  useSystemTabModalApiPublished,
} from "@/stores/tabs/system-tab-modal-bridge";

export const ONBOARDING_COMPLETION_TOAST_ID = "traycer-onboarding-completion";

/**
 * "Make yourself at home": once per install, when the chain of tours ends -
 * completed or skipped, never merely paused - and the screen is free.
 *
 * Eligibility, all of which HOLD the toast rather than drop it:
 * - signed in and mounted under the flow host's desktop / host gates;
 * - the chain is `completed` or `skipped`. For an install that finished the
 *   OLD tour the migration writes a synthetic `skipped` chain
 *   (`legacyCompleted`), which must not toast on upgrade - and its persisted
 *   shape is indistinguishable from a real single replay that was skipped.
 *   So a legacy install qualifies only through an end this window SAW (the
 *   chain was `active` here first); every other install qualifies from the
 *   persisted state too, so a toast held across a reload still fires;
 * - nothing of the flow has the screen (`selectOnboardingBusy`);
 * - the system-tab modal API is published, so "Learn more" has a Settings
 *   to open (`navigateToSettingsSection` no-ops without it).
 *
 * Immediately before showing, the `onboarding-completion` announcement is
 * claimed (`feature-announcements-store`): persisted, so a reload or a later
 * replay never repeats it; the store's documented cross-window race stays
 * accepted.
 */
export function OnboardingCompletionToast(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const chain = useOnboardingFlowStore((state) => state.chain);
  const legacyCompleted = useOnboardingFlowStore(
    (state) => state.legacyCompleted,
  );
  const onboardingBusy = useOnboardingPresenceStore(selectOnboardingBusy);
  const apiPublished = useSystemTabModalApiPublished();
  const consumed = useFeatureAnnouncementsStore((state) =>
    isFeatureAnnouncementConsumed(state.consumed, "onboarding-completion"),
  );
  const claim = useFeatureAnnouncementsStore((state) => state.claim);
  const openLink = useOpenLink();

  // Whether this window saw the chain end (active -> completed/skipped).
  const previousChainRef = useRef<ChainStatus>(chain);
  const endedHereRef = useRef(false);
  useEffect(() => {
    const before = previousChainRef.current;
    previousChainRef.current = chain;
    if (before === "active" && (chain === "completed" || chain === "skipped")) {
      endedHereRef.current = true;
    } else if (chain === "active" || chain === "pending") {
      endedHereRef.current = false;
    }
  }, [chain]);

  useEffect(() => {
    if (consumed || !signedIn || onboardingBusy || !apiPublished) return;
    if (chain !== "completed" && chain !== "skipped") return;
    if (legacyCompleted && !endedHereRef.current) return;
    if (!claim("onboarding-completion")) return;
    toast(
      <OnboardingCompletionToastContent
        toastId={ONBOARDING_COMPLETION_TOAST_ID}
        onStar={() => {
          void openLink(TRAYCER_GITHUB_URL, "app", null);
        }}
      />,
      {
        id: ONBOARDING_COMPLETION_TOAST_ID,
        description: null,
        duration: Infinity,
        cancel: null,
      },
    );
  }, [
    apiPublished,
    chain,
    claim,
    consumed,
    legacyCompleted,
    onboardingBusy,
    openLink,
    signedIn,
  ]);

  return null;
}

/**
 * Two actions, both dispatched at most once (the ref holds inside the same
 * tick, where a second click can land while the toast is on its way out),
 * in the `ActionToastContent` layout - but a dedicated body: that one
 * hardcodes "Later", and neither of these is a later.
 *
 * "Learn more" re-checks that the Settings bridge is still published at
 * click time: if it vanished (a host gate re-closing), the navigation would
 * be lost and the toast is gone, so the button disables instead.
 */
export function OnboardingCompletionToastContent(props: {
  readonly toastId: string;
  readonly onStar: () => void;
}): ReactNode {
  const apiPublished = useSystemTabModalApiPublished();
  const handledRef = useRef(false);
  const [handled, setHandled] = useState(false);

  const dispatch = (action: () => void): void => {
    if (handledRef.current) return;
    handledRef.current = true;
    setHandled(true);
    toast.dismiss(props.toastId);
    action();
  };

  return (
    <div
      className="flex items-center gap-4"
      data-testid="onboarding-completion-toast"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">Make yourself at home</div>
        <div className="mt-1 text-muted-foreground">
          Explore more ways to work with Traycer.
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-1 gap-1.5">
        <Button
          type="button"
          size="sm"
          className="w-full min-w-max"
          disabled={handled}
          onClick={() => {
            dispatch(props.onStar);
          }}
        >
          Star on GitHub
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full min-w-max"
          disabled={handled || !apiPublished}
          onClick={() => {
            // Same-tick re-check: the subscription above disables the
            // button on the next render, but a click can land first.
            if (getSystemTabModalApi() === null) return;
            dispatch(() => {
              navigateToSettingsSection("onboarding");
            });
          }}
        >
          Learn more
        </Button>
      </div>
    </div>
  );
}
