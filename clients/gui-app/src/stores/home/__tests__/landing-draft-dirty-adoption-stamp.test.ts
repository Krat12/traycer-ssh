import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyLandingHostDocument,
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  freshLandingMirrorState,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { setDraftLocalEditListener } from "@/lib/drafts/draft-local-edits";

function resetStore(): void {
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
}

describe("applyLandingHostDocument - dirty local row", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
    setDraftLocalEditListener(null);
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

  it("notifies a local edit for the draft when the dirty row's adoption host changes", () => {
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

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);

    expect(notified).toEqual(["draft-1"]);
  });

  it("does not notify a local edit when neither the adoption host nor the origin changes", () => {
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
          origin: "own",
          adoption: { state: "adopted", hostId: "host-b" },
          // Dirty: generation ahead of syncedGeneration.
          generation: 2,
          syncedGeneration: 1,
        },
      ],
      activeDraftId: null,
    });

    // Same adoption host and same origin as the existing own row: an echo
    // from the host that already holds the queued edit, nothing to requeue.
    const incoming: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 5,
      lastTouchedAt: 99,
      workspace: null,
      ownerHostId: "host-b",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
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

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);

    expect(notified).toEqual([]);
  });
  it("dirty row owned by host-b at hostRevision 100 adopts host-a's revision 5 as hostRevision (owner changed)", () => {
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
          hostRevision: 100,
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
    // Owner changed: hostRevision is set to the new owner's revision, not
    // maxed against the previous owner's (higher) revision.
    expect(draft?.hostRevision).toBe(5);
    expect(draft?.syncedGeneration).toBe(1);
  });

  it("dirty row owned by host-a at hostRevision 100 keeps hostRevision when a host-a document at revision 5 arrives (owner unchanged)", () => {
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
          ownerHostId: "host-a",
          origin: "own",
          adoption: { state: "adopted", hostId: "host-a" },
          hostRevision: 100,
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
    // Owner unchanged: the monotonic max keeps the higher existing
    // hostRevision rather than regressing to the incoming document's.
    expect(draft?.hostRevision).toBe(100);
  });

  it('keeps origin "own" and does not notify when a same-owner document arrives with origin "replica" over a dirty own row', () => {
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
          ownerHostId: "host-a",
          origin: "own",
          adoption: { state: "adopted", hostId: "host-a" },
          // Dirty: generation ahead of syncedGeneration.
          generation: 2,
          syncedGeneration: 1,
        },
      ],
      activeDraftId: null,
    });

    // Same owner and same adoption host as the existing own row, but the
    // document itself carries origin "replica" (a cloud ingest made from a
    // placement that has auto-followed elsewhere).
    const incoming: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 5,
      lastTouchedAt: 99,
      workspace: null,
      ownerHostId: "host-a",
      origin: "replica",
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

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);

    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === "draft-1");
    expect(draft).toBeDefined();
    // Local content untouched - the dirty edit is not clobbered.
    expect(draft?.content).toEqual(localContent);
    // Owner unchanged and existing row was "own": origin stays "own" even
    // though the incoming document says "replica".
    expect(draft?.origin).toBe("own");
    expect(notified).toEqual([]);
  });

  it('stamps origin "replica" from the incoming document when the owner changes on a dirty own row', () => {
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
          ownerHostId: "host-a",
          origin: "own",
          adoption: { state: "adopted", hostId: "host-a" },
          // Dirty: generation ahead of syncedGeneration.
          generation: 2,
          syncedGeneration: 1,
        },
      ],
      activeDraftId: null,
    });

    // Owner changes to host-b: the "own row keeps own" carve-out does not
    // apply, so origin is stamped from the incoming document as before.
    const incoming: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 5,
      lastTouchedAt: 99,
      workspace: null,
      ownerHostId: "host-b",
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
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
    expect(draft?.content).toEqual(localContent);
    expect(draft?.ownerHostId).toBe("host-b");
    expect(draft?.origin).toBe("replica");
  });
});
