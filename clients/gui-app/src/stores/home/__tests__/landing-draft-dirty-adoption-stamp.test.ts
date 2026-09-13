import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyLandingHostDocument,
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  freshLandingMirrorState,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

function resetStore(): void {
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
}

describe("applyLandingHostDocument - dirty local row", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("keeps local content but stamps ownerHostId/origin/adoption/publication from the incoming document when the local row is dirty", () => {
    const localContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "unsaved local edit" }],
        },
      ],
    };
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "draft-1",
          content: localContent,
          selection: null,
          lastTouchedAt: 10,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          ownerHostId: "host-b",
          origin: "replica",
          adoption: { state: "adopted", hostId: "host-b" },
          // Dirty: generation ahead of syncedGeneration.
          generation: 2,
          syncedGeneration: 1,
        },
      ],
      activeDraftId: null,
    });

    const incoming: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 5,
      lastTouchedAt: 99,
      workspace: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "current",
        lastPublishedAt: 100,
        publishedRevision: 5,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };

    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);

    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === "draft-1");
    expect(draft).toBeDefined();
    // Local content untouched - the dirty edit is not clobbered.
    expect(draft?.content).toEqual(localContent);
    // Ownership/origin/adoption/publication now read from the document.
    expect(draft?.ownerHostId).toBe("host-a");
    expect(draft?.origin).toBe("own");
    expect(draft?.adoption).toEqual({ state: "adopted", hostId: "host-a" });
    expect(draft?.publication).toEqual({
      status: "current",
      lastPublishedAt: 100,
      publishedRevision: 5,
      halted: null,
    });
  });
});
