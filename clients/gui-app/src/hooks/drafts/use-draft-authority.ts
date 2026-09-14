import { useCallback, useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";
import { applyIncomingDraftDocument } from "@/lib/drafts/draft-mirror-coordinator";
import { useDraftClaim } from "./use-draft-claim";

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
  readonly settleOwnership: () => Promise<void>;
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
  // The newest attempt per draft, whichever host it was made through. A
  // settlement older than the newest attempt for its draft is stale even
  // when the surface has come back to its host: the cloud has already
  // answered a later claim, and applying the older document would roll the
  // row's owner back behind it.
  const latestAttempt = useRef(new Map<string, number>());
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
  const currentHostRef = useRef(args.tabHostId);
  useEffect(() => {
    currentHostRef.current = args.tabHostId;
  }, [args.tabHostId]);
  const repairRef = useRef<{
    readonly draftId: string;
    readonly tabHostId: string;
    readonly fn: () => void;
  } | null>(null);
  useEffect(() => {
    if (args.draftId === null || args.tabHostId === null) return;
    repairRef.current = {
      draftId: args.draftId,
      tabHostId: args.tabHostId,
      fn: args.repairOnEdit,
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
    latestAttempt.current.set(draftId, attempt);
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
        latestAttempt.current.get(draftId) === attempt;
      if (!stillCurrent()) return true;
      // Re-asked by the coordinator after its blob reads, right before the
      // store mutation: the surface can move while the fetch is in flight.
      await applyIncomingDraftDocument(result.draft, stillCurrent);
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

  const settleOwnership = useCallback(async (): Promise<void> => {
    if (!unowned) return;
    const entry = runClaim();
    if (entry === null) return;
    entry.repairSuppressed = true;
    await entry.promise;
  }, [runClaim, unowned]);

  return { unowned, noteEdit, settleOwnership };
}
