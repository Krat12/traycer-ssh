import { useEffect, type ReactNode } from "react";
import { HostScopeReady } from "@/components/layout/host-readiness-controller";
import { OnboardingCompletionToast } from "@/components/onboarding/tour/onboarding-completion-toast";
import { OnboardingTour } from "@/components/onboarding/tour/onboarding-tour";
import { useOnboardingTourNavigation } from "@/components/onboarding/tour/use-onboarding-tour-navigation";
import { wasTourDismissedThisLaunch } from "@/components/onboarding/tour/use-onboarding-tour-controller";
import { isMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  selectChainResumable,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";

/**
 * The one shell-level mount for the spotlight tours: exactly one
 * `OnboardingTour`, its entry navigation, the launch-time resume and the
 * completion toast. Mounted in `AppShell` beside the folder picker, outside
 * every epic surface / pane provider.
 *
 * Renders nothing until the user is signed in, this is not the installed
 * mobile app (no tour there - a narrow desktop window still gets one), and
 * the default host is ready (`HostScopeReady`, the same seam the landing
 * terminal mounts behind). The welcome modal (`finishModal` / `skipModal`)
 * is what starts a chain; nothing here starts one.
 *
 * The welcome-modal lane owns a host of the same name; the two are
 * reconciled at integration.
 */
export function OnboardingFlowHost(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  if (!signedIn || isMobileApp()) return null;
  return (
    <HostScopeReady scope="default-host">
      <OnboardingFlowHostReady />
    </HostScopeReady>
  );
}

function OnboardingFlowHostReady(): ReactNode {
  useOnboardingLaunchResume();
  useOnboardingTourNavigation();
  return (
    <>
      <OnboardingTour />
      <OnboardingCompletionToast />
    </>
  );
}

/**
 * A paused checkpoint resumes on the NEXT launch - once, when this host
 * first mounts ready - and never in the launch that paused it (Esc marks the
 * launch; see `wasTourDismissedThisLaunch`). An active chain needs nothing:
 * its checkpoint is already the live state. Skipped and completed chains
 * never auto-start.
 */
function useOnboardingLaunchResume(): void {
  useEffect(() => {
    if (wasTourDismissedThisLaunch()) return;
    const flow = useOnboardingFlowStore.getState();
    if (!selectChainResumable(flow)) return;
    flow.resumeChain();
  }, []);
}
