import { useCallback, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DraftPublication } from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";
import { applyIncomingDraftDocument } from "@/lib/drafts/draft-mirror-coordinator";
import { draftClaimUserMessage, useDraftClaim } from "./use-draft-claim";
import { draftPublicationLabel } from "@/lib/drafts/draft-publication-label";

export interface DraftAuthorityControl {
  /**
   * Another host owns this draft (or this host's row was demoted to a
   * replica). Never gates the editor: the first edit claims underneath.
   */
  readonly unowned: boolean;
  readonly claiming: boolean;
  /**
   * The one line shown when a claim was refused. `null` while no claim has
   * failed, including during a claim in flight - the takeover is silent.
   */
  readonly claimError: string | null;
  readonly publicationLabel: string | null;
  /**
   * Called from every edit handler. Claims the draft the first time an
   * unowned draft is edited; a no-op on an owned draft, while a claim is in
   * flight, and after a refusal (which `retry` or `ensureOwned` re-arms).
   */
  readonly noteEdit: () => void;
  /**
   * The submit path: resolves `true` once this host owns the draft, joining
   * a claim already in flight, and `false` on a refusal (with `claimError`
   * set for the inline notice).
   */
  readonly ensureOwned: () => Promise<boolean>;
  readonly retry: () => void;
}

/**
 * A refusal, keyed by the draft it was for. Keyed rather than reset: a
 * refusal for one draft must not disarm or narrate on the next draft this
 * surface shows, and deriving from the key needs no effect to clear it.
 */
interface ClaimRefusal {
  readonly draftId: string;
  readonly message: string | null;
}

export function useDraftAuthorityControl(args: {
  readonly draftId: string | null;
  readonly ownerHostId: string | null;
  readonly origin: "own" | "replica" | null;
  readonly tabHostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly publication: DraftPublication | null;
}): DraftAuthorityControl {
  const { mutation: claimMutation, claim: claimDraft } = useDraftClaim(
    args.client,
  );
  const unowned =
    args.tabHostId !== null &&
    args.draftId !== null &&
    draftRequiresClaim(args.ownerHostId, args.origin, args.tabHostId);
  // One claim per arming. A refusal disarms so a stream of keystrokes does
  // not hammer the host with a claim it just refused; `retry` and the submit
  // path re-arm by clearing it. A claim that lands clears it too, and an
  // owned draft reads no refusal at all, so a later demotion starts armed.
  const [refusal, setRefusal] = useState<ClaimRefusal | null>(null);
  const disarmed =
    unowned && refusal !== null && refusal.draftId === args.draftId;
  const claimError = disarmed ? refusal.message : null;
  const inflight = useRef<Promise<boolean> | null>(null);

  const runClaim = useCallback((): Promise<boolean> => {
    const pending = inflight.current;
    if (pending !== null) return pending;
    const draftId = args.draftId;
    if (draftId === null) return Promise.resolve(false);
    const attempt = (async (): Promise<boolean> => {
      const result = await claimDraft(draftId);
      if (result.status === "ok" || result.status === "already-owned") {
        setRefusal(null);
        await applyIncomingDraftDocument(result.draft);
        return true;
      }
      setRefusal({ draftId, message: draftClaimUserMessage(result) });
      return false;
    })().finally(() => {
      if (inflight.current === attempt) inflight.current = null;
    });
    inflight.current = attempt;
    return attempt;
  }, [args.draftId, claimDraft]);

  const noteEdit = useCallback((): void => {
    if (!unowned || disarmed) return;
    void runClaim();
  }, [disarmed, runClaim, unowned]);

  const ensureOwned = useCallback((): Promise<boolean> => {
    if (!unowned) return Promise.resolve(true);
    return runClaim();
  }, [runClaim, unowned]);

  const retry = useCallback((): void => {
    void ensureOwned();
  }, [ensureOwned]);

  return {
    unowned,
    claiming: claimMutation.isPending,
    claimError,
    publicationLabel: draftPublicationLabel(args.publication),
    noteEdit,
    ensureOwned,
    retry,
  };
}
