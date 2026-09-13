import { useEffect, type ReactNode } from "react";
import { WelcomeModalFooter } from "@/components/onboarding/welcome/welcome-modal-footer";
import type { WelcomeScan } from "@/components/onboarding/welcome/use-welcome-scan";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

/**
 * Page 2 of the welcome modal: the sessions the background scan found,
 * grouped provider → folder → session, and the Import / Skip import choice.
 *
 * PLACEHOLDER - the signature is final (every exit is a callback; the modal
 * writes the flow store), the body is ticket 2.3's. What is already real is
 * the announcement receipt: reaching this page IS the session-import
 * announcement (parent contract 2), so the release toast never follows a
 * user who saw it - while a user who skipped before it still gets one.
 */
export function WelcomeSessionsPage(props: {
  readonly welcomeScan: WelcomeScan;
  /** Called right after `startSessionImportRun`; the modal finishes as `sessions`. */
  readonly onImportStarted: () => void;
  readonly onSkipImport: () => void;
  /** The scan settled with nothing importable, or the host cannot scan. */
  readonly onNoSessions: () => void;
  /** An import is already running on this host; the modal finishes as `sessions`. */
  readonly onAlreadyRunningContinue: () => void;
}): ReactNode {
  const { welcomeScan, onSkipImport } = props;
  const consumeAnnouncement = useFeatureAnnouncementsStore(
    (state) => state.consume,
  );
  useEffect(() => {
    consumeAnnouncement("session-import");
  }, [consumeAnnouncement]);
  const importableCount = welcomeScan.importableCount;
  return (
    <>
      <div
        data-testid="welcome-sessions-page"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-4"
      >
        <p className="text-ui-sm text-muted-foreground">
          {welcomeScan.scan.state.phase === "scanning"
            ? "Looking for your work on this machine…"
            : `${importableCount.toLocaleString()} ${importableCount === 1 ? "session" : "sessions"} found.`}
        </p>
      </div>
      <WelcomeModalFooter
        leading={null}
        secondary={{ label: "Skip import", onSelect: onSkipImport }}
        primary={{
          label: `Import ${importableCount.toLocaleString()} ${importableCount === 1 ? "task" : "tasks"}`,
          // Placeholder: disabled until 2.3 submits through the run
          // controller, because reporting `onImportStarted` without a run
          // would send the user down the `sessions` branch with nothing
          // imported.
          onSelect: props.onImportStarted,
          disabled: true,
          pending: false,
        }}
      />
    </>
  );
}
