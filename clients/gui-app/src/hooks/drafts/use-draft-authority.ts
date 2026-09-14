import { useCallback, useLayoutEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DraftDocument } from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";
import { applyIncomingDraftDocument } from "@/lib/drafts/draft-mirror-coordinator";
import { appLogger, describeLogError } from "@/lib/logger";
import { useDraftClaim } from "./use-draft-claim";
import { bindLandingDraftOwnership } from "@/stores/home/landing-draft-store";
import { bindComposerDraftOwnership } from "@/stores/composer/composer-draft-store";

function bindOwnership(document: DraftDocument, hostId: string): void {
  if (document.kind === "landing") {
    bindLandingDraftOwnership(document.draftId, hostId);
  } else if (document.kind === "chat-composer") {
    bindComposerDraftOwnership(document.draftId, hostId);
  }
}

export interface DraftAuthorityControl {
  /**
   * Another host owns this draft (or this host's row was demoted to a
   * replica). Never gates the editor and never renders: the first edit
   * claims underneath, and a refused claim repairs underneath.
   */
  readonly unowned: boolean;
  /**
   * Called from every edit handler. On an unowned draft, claims it for this
   * host; a refusal runs the surface's `repairOnEdit` (a fresh draft of this
   * host's own carrying the content). A no-op on an owned draft and while a
   * claim is in flight. Nothing is ever shown for either outcome.
   */
  readonly noteEdit: () => void;
  /**
   * The submit path: resolves once a pending or fresh claim has settled, so
   * a send on a draft this host now owns deletes it everywhere. A refusal
   * resolves too - the send proceeds on the row as it is, and the local
   * retirement receipt keeps the original from returning to this device.
   */
  readonly settleOwnership: () => Promise<SettledOwnership>;
}

export interface SettledOwnership {
  /**
   * The caller did NOT dispatch after the settle (a guard changed, a launch
   * was dropped). A refusal that an edit had armed a repair for is repaired
   * now instead of staying suppressed for a send that never happened.
   */
  readonly abandon: () => void;
}

interface PendingClaim {
  readonly promise: Promise<boolean>;
  repairArmed: boolean;
  /**
   * A submit joined this claim. Its refusal handling is the send itself
   * (proceed on the row as it is), so an edit-armed fork must not re-key
   * the tab underneath the deferred send.
   */
  repairSuppressed: boolean;
}

/**
 * A claim is made through one host's client and its outcome names that
 * host as the owner, so a pending claim is identified by the host it was
 * made on as well as the draft: an edit observed after the composer moved
 * to another host starts that host's own claim rather than riding the old
 * one and ending up owned by a host the composer no longer shows.
 */
function pendingClaimKey(tabHostId: string, draftId: string): string {
  return `${tabHostId}:${draftId}`;
}

export function useDraftAuthorityControl(args: {
  readonly draftId: string | null;
  readonly ownerHostId: string | null;
  readonly origin: "own" | "replica" | null;
  readonly tabHostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  /**
   * The surface's silent repair for a claim the host refused. Runs at most
   * once per refusal; after it the draft reads as owned (a new row, or a
   * detached identity), so nothing here needs to remember the refusal.
   */
  readonly repairOnEdit: () => void;
}): DraftAuthorityControl {
  const { claim: claimDraft } = useDraftClaim(args.client);
  const unowned =
    args.tabHostId !== null &&
    args.draftId !== null &&
    draftRequiresClaim(args.ownerHostId, args.origin, args.tabHostId);
  // Every pending claim, keyed by the draft it is for: this hook instance
  // can move to another draft while a claim is pending (a chat draft's
  // identity is re-minted by the repair) and back again, and B must not ride
  // A's outcome nor A be claimed twice. `repairArmed` records whether an edit
  // has attached the refusal repair to an attempt: a claim the submit path
  // started has none, and the first edit that joins it arms exactly one.
  const inflight = useRef(new Map<string, PendingClaim>());
  // The newest attempt per draft that has APPLIED its document, whichever
  // host it was made through. A success older than that is stale even when
  // the surface has come back to its host: a later claim has already been
  // answered and applied, and the older document would roll the row's owner
  // back behind it. Only an applied success supersedes - a newer attempt
  // that was refused must not discard an older, still-current success.
  const latestApplied = useRef(new Map<string, number>());
  const attemptCounter = useRef(0);
  // Read through a ref by the in-flight continuation: the repair belongs to
  // the render that observes the refusal, not the one that started the claim
  // - but only for THAT draft. Keyed by draftId like `inflight`, so a claim
  // that outlives a move to another (unowned) draft can never fire the new
  // draft's repair: B must not ride A's outcome, in either direction.
  // The host the surface currently shows, for the in-flight continuation:
  // a claim made through a host the composer has since left must not apply
  // its document, or the row would roll back to that host's ownership after
  // the current host's own claim landed.
  // Layout effects, not passive ones: both refs must move in the same commit
  // as the host change, before a claim continuation queued behind it can
  // read them.
  const currentHostRef = useRef(args.tabHostId);
  useLayoutEffect(() => {
    currentHostRef.current = args.tabHostId;
  }, [args.tabHostId]);
  // The latest `noteEdit` and the draft the surface shows now, for a
  // settlement that finds its host superseded: the re-claim is for THIS
  // draft only - a move to another draft is not an edit of that draft.
  const noteEditRef = useRef<() => void>(() => undefined);
  const currentDraftRef = useRef(args.draftId);
  useLayoutEffect(() => {
    currentDraftRef.current = args.draftId;
  }, [args.draftId]);
  const repairRef = useRef<{
    readonly draftId: string;
    readonly tabHostId: string;
    readonly fn: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    if (args.draftId === null || args.tabHostId === null) {
      repairRef.current = null;
      return;
    }
    repairRef.current = {
      draftId: args.draftId,
      tabHostId: args.tabHostId,
      fn: args.repairOnEdit,
    };
    // A refusal that settles after the surface is gone (unmount, or an
    // identity that went null) must not fork or detach a draft nobody shows.
    return () => {
      repairRef.current = null;
    };
  }, [args.draftId, args.repairOnEdit, args.tabHostId]);

  // A refusal repairs only while the surface still shows the draft on the
  // host the claim was made through: a claim from a host the composer has
  // since left is superseded by the current host's own claim, and must not
  // re-key the draft underneath it.
  const repairFor = useCallback((draftId: string, tabHostId: string): void => {
    const repair = repairRef.current;
    if (
      repair !== null &&
      repair.draftId === draftId &&
      repair.tabHostId === tabHostId
    ) {
      repair.fn();
    }
  }, []);

  const runClaim = useCallback((): PendingClaim | null => {
    const draftId = args.draftId;
    const tabHostId = args.tabHostId;
    if (draftId === null || tabHostId === null) return null;
    const key = pendingClaimKey(tabHostId, draftId);
    const pending = inflight.current.get(key);
    if (pending !== undefined) return pending;
    attemptCounter.current += 1;
    const attempt = attemptCounter.current;
    const promise = (async (): Promise<boolean> => {
      const result = await claimDraft(draftId);
      if (result.status !== "ok" && result.status !== "already-owned") {
        return false;
      }
      // Superseded: the surface moved to another host while this claim ran.
      // Its document names this host as owner and would route the dirty row
      // back here; the current host's claim is the one that counts.
      const stillCurrent = (): boolean =>
        currentHostRef.current === tabHostId &&
        (latestApplied.current.get(draftId) ?? 0) <= attempt;
      const reclaimOnCurrentHost = (): void => {
        // The surface moved hosts and no further edit started that host's
        // claim: start it now, for this same draft, so the edit that began
        // this claim is not stranded on the old host.
        if (
          currentHostRef.current !== tabHostId &&
          currentDraftRef.current === draftId
        ) {
          noteEditRef.current();
        }
      };
      if (!stillCurrent()) {
        reclaimOnCurrentHost();
        return true;
      }
      // Re-asked by the coordinator after its blob reads, right before the
      // store mutation: the surface can move while the fetch is in flight.
      // A failed apply (a blob read that threw) does not undo the claim the
      // cloud already granted: the host owns the row, and its next echo
      // brings the document; the settle must not hang its callers on it.
      try {
        await applyIncomingDraftDocument(result.draft, stillCurrent);
      } catch (error: unknown) {
        appLogger.warn("[draft-authority] claimed document did not apply", {
          error: describeLogError(error),
        });
        // The claim committed: bind the row to its new owner without the
        // document so a deferred submit's delete routes to the host that
        // holds the row, not the previous owner.
        if (stillCurrent()) bindOwnership(result.draft, tabHostId);
        return true;
      }
      if (stillCurrent()) {
        latestApplied.current.set(draftId, attempt);
      } else {
        // The coordinator declined the mutation after its blob reads: the
        // surface moved during the apply, past the pre-await check.
        reclaimOnCurrentHost();
      }
      return true;
    })();
    const entry: PendingClaim = {
      promise,
      repairArmed: false,
      repairSuppressed: false,
    };
    void promise.finally(() => {
      if (inflight.current.get(key) === entry) inflight.current.delete(key);
    });
    inflight.current.set(key, entry);
    return entry;
  }, [args.draftId, args.tabHostId, claimDraft]);

  const noteEdit = useCallback((): void => {
    if (!unowned) return;
    // `unowned` narrows both `args.draftId` and `args.tabHostId` to strings.
    const draftId = args.draftId;
    const tabHostId = args.tabHostId;
    // An edit joins a claim already in flight - one the submit path or an
    // earlier edit started - and arms the repair on it once. Dropping the
    // edit instead would leave it on the unowned identity if that claim is
    // refused.
    const entry = runClaim();
    if (entry === null || entry.repairArmed) return;
    entry.repairArmed = true;
    void entry.promise.then((owned) => {
      if (!owned && !entry.repairSuppressed) repairFor(draftId, tabHostId);
    });
  }, [args.draftId, args.tabHostId, repairFor, runClaim, unowned]);

  useLayoutEffect(() => {
    noteEditRef.current = noteEdit;
  }, [noteEdit]);

  const settleOwnership = useCallback(async (): Promise<SettledOwnership> => {
    const noop: SettledOwnership = { abandon: () => undefined };
    if (!unowned) return noop;
    const draftId = args.draftId;
    const tabHostId = args.tabHostId;
    const entry = runClaim();
    if (entry === null) return noop;
    entry.repairSuppressed = true;
    const owned = await entry.promise;
    return {
      abandon: () => {
        if (owned || !entry.repairArmed || !entry.repairSuppressed) return;
        entry.repairSuppressed = false;
        repairFor(draftId, tabHostId);
      },
    };
  }, [args.draftId, args.tabHostId, repairFor, runClaim, unowned]);

  return { unowned, noteEdit, settleOwnership };
}
