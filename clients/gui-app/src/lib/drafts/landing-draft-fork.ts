import { v4 as uuidv4 } from "uuid";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

/**
 * The self-repair for a landing draft this host could not claim: carry its
 * content into a fresh draft of this host's own, re-key the tab onto it, and
 * retire the original locally. The copy adopts and publishes through the
 * normal path, and where that path has no host to publish to it stays a
 * local draft - the same fallback every new draft already has. Nothing is
 * shown; the user keeps typing into what reads as the same draft.
 *
 * The original is retired, not deleted: its owner host keeps its row (and
 * the cloud copy), and the retirement receipt keeps it from being ingested
 * back onto this device as a duplicate.
 *
 * Returns the new draft id, or `null` when the source no longer exists.
 */
export function forkLandingDraftInPlace(sourceId: string): string | null {
  const nextId = uuidv4();
  const replaced = tabCommandCoordinator.replaceDraftWithDraft({
    previousDraftId: sourceId,
    nextDraftId: nextId,
  });
  if (replaced !== null) return nextId;
  // No strip item for the source (a surface outside the strip): the store
  // alone carries the fork, and the active draft follows it.
  const store = useLandingDraftStore.getState();
  if (!store.forkDraft(sourceId, nextId)) return null;
  store.applyHostDelete(sourceId);
  return nextId;
}
