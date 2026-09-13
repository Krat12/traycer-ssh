import type { ReactNode } from "react";
import { WelcomeModalFooter } from "@/components/onboarding/welcome/welcome-modal-footer";

/**
 * Page 1 of the welcome modal: the providers grid.
 *
 * PLACEHOLDER - the signature is final (the modal wires `onContinue` /
 * `onSkip` to its Continue branch and `skipModal`), the body is ticket 2.2's:
 * six major provider tiles with install badge, account line and enable
 * switch, plus a "+N more providers" disclosure. The data hooks
 * (`useProvidersList`, `useProvidersSetEnabled`) belong to that body, not to
 * the modal, so nothing here reads the host yet.
 */
export function WelcomeProvidersPage(props: {
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}): ReactNode {
  const { onContinue, onSkip } = props;
  return (
    <>
      <div
        data-testid="welcome-providers-page"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-4"
      >
        <p className="text-ui-sm text-muted-foreground">
          Your coding agents will appear here.
        </p>
      </div>
      <WelcomeModalFooter
        leading={null}
        secondary={{ label: "Skip setup", onSelect: onSkip }}
        primary={{
          label: "Continue",
          onSelect: onContinue,
          disabled: false,
          pending: false,
        }}
      />
    </>
  );
}
