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
  const inflight = useRef<Promise<boolean> | null>(null);
  // Read through a ref by the in-flight continuation: the repair belongs to
  // the render that observes the refusal, not the one that started the claim.
  const repairRef = useRef(args.repairOnEdit);
  useEffect(() => {
    repairRef.current = args.repairOnEdit;
  }, [args.repairOnEdit]);

  const runClaim = useCallback((): Promise<boolean> => {
    const pending = inflight.current;
    if (pending !== null) return pending;
    const draftId = args.draftId;
    if (draftId === null) return Promise.resolve(false);
    const attempt = (async (): Promise<boolean> => {
      const result = await claimDraft(draftId);
      if (result.status !== "ok" && result.status !== "already-owned") {
        return false;
      }
      await applyIncomingDraftDocument(result.draft);
      return true;
    })().finally(() => {
      if (inflight.current === attempt) inflight.current = null;
    });
    inflight.current = attempt;
    return attempt;
  }, [args.draftId, claimDraft]);

  const noteEdit = useCallback((): void => {
    if (!unowned || inflight.current !== null) return;
    void runClaim().then((owned) => {
      if (!owned) repairRef.current();
    });
  }, [runClaim, unowned]);

  const settleOwnership = useCallback(async (): Promise<void> => {
    if (!unowned) return;
    await runClaim();
  }, [runClaim, unowned]);

  return { unowned, noteEdit, settleOwnership };
}
