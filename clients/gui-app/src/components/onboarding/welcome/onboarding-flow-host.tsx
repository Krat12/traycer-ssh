import { useState, type ReactNode } from "react";
import { WelcomeModal } from "@/components/onboarding/welcome/welcome-modal";
import { isMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  selectFirstRunModalDue,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";

/**
 * The onboarding flow's mount point (parent contract 9): inside `AppShell`,
 * so it has the router, the dialog primitives and the toaster; renders
 * nothing until the user is signed in, and never in the installed mobile app
 * (there is no onboarding there after the old tour's removal).
 *
 * Owns exactly one piece of state the flow store must NOT hold: whether the
 * welcome modal was dismissed with Esc THIS SESSION. The store keeps `modal:
 * "in-progress"` through a pause on purpose - that is what brings the modal
 * back on the next launch - so the "do not reopen right now" fact lives
 * here, in memory, and is released when Settings asks for the modal again
 * (`showWelcomeModalAgain` sets `modal` back to `pending`).
 */
export function OnboardingFlowHost(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const modalDue = useOnboardingFlowStore(selectFirstRunModalDue);
  const modalPending = useOnboardingFlowStore(
    (state) => state.modal === "pending",
  );
  const [dismissed, setDismissed] = useState(false);
  // Released the moment the store says `pending` again, adjusted during
  // render rather than in an effect: `startModal` moves `pending` back to
  // `in-progress` on the modal's first commit, and a reset that waited for
  // an effect would see that commit with the flag still up.
  if (modalPending && dismissed) setDismissed(false);

  if (!signedIn || isMobileApp()) return null;
  return (
    <>
      {modalDue && !dismissed ? (
        <WelcomeModal onPaused={() => setDismissed(true)} />
      ) : null}
      {/* child 3: <OnboardingTour /> and the completion toast mount here */}
    </>
  );
}
