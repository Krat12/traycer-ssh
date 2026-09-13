import { useEffect, useMemo, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSurfaceReadiness } from "@/components/layout/host-readiness-controller-context";
import { WelcomeConnecting } from "@/components/onboarding/welcome/welcome-connecting";
import { WelcomeProvidersPage } from "@/components/onboarding/welcome/welcome-providers-page";
import { WelcomeSessionsPage } from "@/components/onboarding/welcome/welcome-sessions-page";
import {
  useWelcomeScan,
  type WelcomeScan,
} from "@/components/onboarding/welcome/use-welcome-scan";
import { useWelcomeRoster } from "@/components/onboarding/welcome/use-welcome-roster";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { cn } from "@/lib/utils";
import { useOnboardingFlowStore } from "@/stores/onboarding/onboarding-flow-store";
import type { OnboardingBranch } from "@/stores/onboarding/onboarding-tour-catalog";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";

const NO_PROVIDERS: ReadonlyArray<ProviderId> = [];

type WelcomeModalPage = 1 | 2;

/** The taxonomy spells the page as a string enum, not a tally. */
function analyticsPage(page: WelcomeModalPage): "1" | "2" {
  return page === 1 ? "1" : "2";
}

/**
 * The first-run welcome modal: an 80vw × 80vh dialog over whatever route the
 * app opened on, with two pages - providers, then the sessions the scan found
 * for them.
 *
 * Three exits, three store actions, no local close state: Esc PAUSES
 * (`pauseModal`; the flow host hides the modal for this session and it
 * reopens next launch on the same page), Skip and Continue FINISH
 * (`skipModal` / `finishModal(branch)`), after which `modal` leaves
 * `pending | in-progress` and the flow host unmounts this. An outside click
 * does nothing at all - a modal that closes under a stray click is one the
 * user has to find their way back to.
 *
 * The scan is started HERE rather than on page 2, and from the moment the
 * modal opens: the sessions page should be filled in by the time the user
 * reaches it, and switching pages must not restart it.
 */
export function WelcomeModal(props: {
  /** Esc: the flow host records the dismissal for this session. */
  readonly onPaused: () => void;
}): ReactNode {
  const { onPaused } = props;
  const modalPage = useOnboardingFlowStore((state) => state.modalPage);
  const setModalPage = useOnboardingFlowStore((state) => state.setModalPage);
  const pauseModal = useOnboardingFlowStore((state) => state.pauseModal);
  const finishModal = useOnboardingFlowStore((state) => state.finishModal);
  const skipModal = useOnboardingFlowStore((state) => state.skipModal);
  const setModalOpen = useOnboardingPresenceStore(
    (state) => state.setModalOpen,
  );

  // Once, on mount: a fresh install moves `pending` → `in-progress`; a
  // launch that rehydrated `in-progress` (paused on a page) is left alone,
  // page included.
  useEffect(() => {
    const flow = useOnboardingFlowStore.getState();
    if (flow.modal === "pending") flow.startModal();
  }, []);

  // Presence, for the ambient surfaces that hold while this is up.
  useEffect(() => {
    setModalOpen(true);
    return () => {
      setModalOpen(false);
    };
  }, [setModalOpen]);

  // The frame shows before the host is up; the pages wait for it. Both the
  // readiness verdict AND a named stream host are required - the scan and,
  // later, the import run are aimed at the stream binding, and a `ready`
  // verdict with no host to stream from is the gap between a host swap and
  // the effect that rebuilds the binding.
  const readiness = useSurfaceReadiness("default-host", null);
  const streamHostId = useStreamRuntimeBinding()?.hostId ?? null;
  const hostReady = readiness.kind === "ready" && streamHostId !== null;

  const roster = useWelcomeRoster();
  const { providers } = roster;
  const enabledProviderIds = useMemo(
    () =>
      providers === undefined
        ? NO_PROVIDERS
        : providers
            .filter((provider) => provider.enabled)
            .map((provider) => provider.providerId),
    [providers],
  );
  const welcomeScan = useWelcomeScan({ open: true, enabledProviderIds });

  const skip = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalSkipped, {
      page: analyticsPage(modalPage),
    });
    skipModal();
  };

  const continueFromProviders = (): void => {
    // The page disables Continue until the roster has settled (resolved,
    // not mid-refresh, not in error, every toggle refreshed into it); this
    // is the same fact read at the moment of the click, so a click that
    // raced the query cannot finish the modal on an empty or stale roster.
    if (providers === undefined || !roster.settled) return;
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalContinued, {
      page: "1",
      enabled_provider_count: enabledProviderIds.length,
      session_count: welcomeScan.importableCount,
    });
    if (welcomeBranchAfterProviders(welcomeScan) === "no-sessions") {
      finishModal("no-sessions");
      return;
    }
    setModalPage(2);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix routes Esc here; outside interaction is prevented below, so
        // this is the pause gesture and nothing else.
        if (open) return;
        pauseModal();
        onPaused();
      }}
    >
      <DialogContent
        data-testid="welcome-modal"
        showCloseButton={false}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        // An unmodified `max-w-*` displaces the primitive's safe-area cap by
        // design (see `dialog.tsx`), so the cap is composed back in: the
        // smaller of 80vw and the safe region, at both breakpoints. Fluid:
        // both axes are viewport fractions.
        className="flex h-[80vh] w-[80vw] max-w-[min(80vw,var(--safe-area-width))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(80vw,var(--safe-area-width))]"
      >
        <WelcomeModalHeader page={modalPage} hostReady={hostReady} />
        {hostReady ? (
          <WelcomeModalBody
            page={modalPage}
            welcomeScan={welcomeScan}
            onContinueFromProviders={continueFromProviders}
            onSkip={skip}
            onFinish={finishModal}
          />
        ) : (
          <WelcomeConnecting onSkip={skip} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Continue branch from page 1 (plan §Branch decision): straight to the
 * `no-sessions` tours when the host cannot scan or nothing enabled can be
 * scanned, or when the scan already finished with nothing to import; the
 * sessions page otherwise - including while the scan is still running or
 * has failed, since page 2 owns the copy for both.
 */
function welcomeBranchAfterProviders(
  welcomeScan: WelcomeScan,
): "no-sessions" | "sessions-page" {
  if (!welcomeScan.eligible) return "no-sessions";
  const { phase } = welcomeScan.scan.state;
  if (phase === "complete" && welcomeScan.importableCount === 0) {
    return "no-sessions";
  }
  return "sessions-page";
}

function WelcomeModalBody(props: {
  readonly page: WelcomeModalPage;
  readonly welcomeScan: WelcomeScan;
  readonly onContinueFromProviders: () => void;
  readonly onSkip: () => void;
  readonly onFinish: (branch: OnboardingBranch) => void;
}): ReactNode {
  const { page, welcomeScan, onContinueFromProviders, onSkip, onFinish } =
    props;
  // "Shown" is the page being ON SCREEN, so it is keyed on the page and
  // fires only from the body - the connecting state is not a page.
  useEffect(() => {
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalShown, {
      page: analyticsPage(page),
    });
  }, [page]);
  if (page === 1) {
    return (
      <WelcomeProvidersPage
        onContinue={onContinueFromProviders}
        onSkip={onSkip}
      />
    );
  }
  return (
    <WelcomeSessionsPage
      welcomeScan={welcomeScan}
      onImportStarted={() => onFinish("sessions")}
      onSkipImport={() => onFinish("no-sessions")}
      onNoSessions={() => onFinish("no-sessions")}
      onAlreadyRunningContinue={() => onFinish("sessions")}
    />
  );
}

const PAGE_COPY: Readonly<
  Record<
    WelcomeModalPage,
    { readonly title: string; readonly subtitle: string }
  >
> = {
  1: {
    title: "Welcome to Traycer",
    subtitle:
      "Turn on the coding agents you use. Traycer checks the accounts you're already signed in to.",
  },
  2: {
    title: "Bring your recent work",
    subtitle:
      "Sessions found on this machine become Traycer tasks. Untick anything you'd rather leave behind.",
  },
};

function WelcomeModalHeader(props: {
  readonly page: WelcomeModalPage;
  readonly hostReady: boolean;
}): ReactNode {
  const { page, hostReady } = props;
  // While connecting the header keeps page 1's title - it is where the user
  // lands - and says what the body is waiting on, so the dialog's accessible
  // description is never a promise about a grid that is not there yet.
  const copy = PAGE_COPY[hostReady ? page : 1];
  return (
    <DialogHeader className="shrink-0 gap-1 px-6 pt-5 pb-3">
      <div className="flex items-start justify-between gap-4">
        <DialogTitle className="text-ui-lg">{copy.title}</DialogTitle>
        <ol
          aria-label="Setup steps"
          className="flex shrink-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
        >
          <WelcomeStep number={1} label="Providers" current={page === 1} />
          <li aria-hidden>·</li>
          <WelcomeStep number={2} label="Sessions" current={page === 2} />
        </ol>
      </div>
      <DialogDescription>
        {hostReady ? copy.subtitle : "Connecting to your machine…"}
      </DialogDescription>
    </DialogHeader>
  );
}

function WelcomeStep(props: {
  readonly number: WelcomeModalPage;
  readonly label: string;
  readonly current: boolean;
}): ReactNode {
  const { number, label, current } = props;
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn("flex items-center gap-1", current && "text-foreground")}
    >
      <span className={cn("tabular-nums", current && "font-medium")}>
        {number}
      </span>
      <span>{label}</span>
    </li>
  );
}
