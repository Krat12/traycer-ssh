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
  // Keyed by the draft it is for: this hook instance can move to another
  // draft while a claim is pending (a chat draft's identity is re-minted by
  // the repair), and B must not ride A's outcome.
  // `repairArmed` records whether an edit has attached the refusal repair
  // to this attempt: a claim the submit path started has none, and the
  // first edit that joins it arms exactly one.
  const inflight = useRef<{
    readonly draftId: string;
    readonly promise: Promise<boolean>;
    repairArmed: boolean;
  } | null>(null);
  // Read through a ref by the in-flight continuation: the repair belongs to
  // the render that observes the refusal, not the one that started the claim
  // - but only for THAT draft. Keyed by draftId like `inflight`, so a claim
  // that outlives a move to another (unowned) draft can never fire the new
  // draft's repair: B must not ride A's outcome, in either direction.
  const repairRef = useRef<{
    readonly draftId: string;
    readonly fn: () => void;
  } | null>(null);
  useEffect(() => {
    if (args.draftId === null) return;
    repairRef.current = { draftId: args.draftId, fn: args.repairOnEdit };
  }, [args.draftId, args.repairOnEdit]);

  const repairFor = useCallback((draftId: string): void => {
    const repair = repairRef.current;
    if (repair !== null && repair.draftId === draftId) repair.fn();
  }, []);

  const runClaim = useCallback((): Promise<boolean> => {
    const draftId = args.draftId;
    if (draftId === null) return Promise.resolve(false);
    const pending = inflight.current;
    if (pending !== null && pending.draftId === draftId) return pending.promise;
    const promise = (async (): Promise<boolean> => {
      const result = await claimDraft(draftId);
      if (result.status !== "ok" && result.status !== "already-owned") {
        return false;
      }
      await applyIncomingDraftDocument(result.draft);
      return true;
    })();
    const entry = { draftId, promise, repairArmed: false };
    void promise.finally(() => {
      if (inflight.current === entry) inflight.current = null;
    });
    inflight.current = entry;
    return promise;
  }, [args.draftId, claimDraft]);

  const noteEdit = useCallback((): void => {
    if (!unowned) return;
    // `unowned` narrows `args.draftId` to a string.
    const draftId = args.draftId;
    const pending = inflight.current;
    // An edit joins a claim already in flight - one the submit path or an
    // earlier edit started - and arms the repair on it once. Dropping the
    // edit instead would leave it on the unowned identity if that claim is
    // refused.
    if (pending !== null && pending.draftId === draftId) {
      if (pending.repairArmed) return;
      pending.repairArmed = true;
      void pending.promise.then((owned) => {
        if (!owned) repairFor(draftId);
      });
      return;
    }
    void runClaim();
    const started = inflight.current;
    if (started === null || started.draftId !== draftId) return;
    started.repairArmed = true;
    void started.promise.then((owned) => {
      if (!owned) repairFor(draftId);
    });
  }, [args.draftId, repairFor, runClaim, unowned]);

  const settleOwnership = useCallback(async (): Promise<void> => {
    if (!unowned) return;
    await runClaim();
  }, [runClaim, unowned]);

  return { unowned, noteEdit, settleOwnership };
}
