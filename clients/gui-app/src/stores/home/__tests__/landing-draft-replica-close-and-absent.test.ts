import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  dropForeignLandingMirrorsAbsent,
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import {
  setDraftLocalEditListener,
  setDraftLocalFlushListener,
} from "@/lib/drafts/draft-local-edits";

const NON_EMPTY_CONTENT = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

function baseDraft(
  id: string,
  overrides: Partial<LandingDraftTab>,
): LandingDraftTab {
  return {
    id,
    content: NON_EMPTY_CONTENT,
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    adoption: { state: "unadopted" },
    hostRevision: 0,
    generation: 0,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: false,
    ...overrides,
  };
}

describe("landing draft store: closeDraft origin behavior", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("closing a replica row sets closed:true without bumping generation or notifying local-edit/flush listeners", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("replica-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("replica-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(true);
    expect(after?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(notified).toEqual([]);
  });

  it("closing an own row bumps generation and notifies local-edit/flush listeners", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("own-1", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("own-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(true);
    expect(after?.generation).toBe(4);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(notified).toEqual(["own-1"]);
  });
});

describe("landing draft store: openDraft origin behavior", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("reopening a closed replica is local view state: generation unchanged, no listener call", () => {
    const editNotified: string[] = [];
    const flushNotified: string[] = [];
    setDraftLocalEditListener((id) => editNotified.push(id));
    setDraftLocalFlushListener((id) => flushNotified.push(id));

    const draft = baseDraft("replica-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: null });

    useLandingDraftStore.getState().openDraft("replica-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(false);
    expect(after?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBe("replica-1");
    expect(editNotified).toEqual([]);
    expect(flushNotified).toEqual([]);
  });

  it("reopening a closed own row bumps generation and notifies", () => {
    const editNotified: string[] = [];
    const flushNotified: string[] = [];
    setDraftLocalEditListener((id) => editNotified.push(id));
    setDraftLocalFlushListener((id) => flushNotified.push(id));

    const draft = baseDraft("own-1", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: null });

    useLandingDraftStore.getState().openDraft("own-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(false);
    expect(after?.generation).toBe(4);
    expect(useLandingDraftStore.getState().activeDraftId).toBe("own-1");
    expect(editNotified).toEqual(["own-1"]);
    expect(flushNotified).toEqual(["own-1"]);
  });
});

describe("landing draft store: dropForeignLandingMirrorsAbsent", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("drops the clean, unlisted foreign replica and keeps a dirty one, a listed one, an own row, and a same-host replica", () => {
    const cleanUnlistedForeign = baseDraft("clean-unlisted-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    const dirtyForeign = baseDraft("dirty-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });
    const listedForeign = baseDraft("listed-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    const ownRow = baseDraft("own-row", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    const sameHostReplica = baseDraft("same-host-replica", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });

    useLandingDraftStore.setState({
      drafts: [
        cleanUnlistedForeign,
        dirtyForeign,
        listedForeign,
        ownRow,
        sameHostReplica,
      ],
      activeDraftId: null,
    });

    dropForeignLandingMirrorsAbsent("host-a", new Set(["listed-foreign"]));

    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).not.toContain("clean-unlisted-foreign");
    expect(ids).toContain("dirty-foreign");
    expect(ids).toContain("listed-foreign");
    expect(ids).toContain("own-row");
    expect(ids).toContain("same-host-replica");
  });
});

describe("landing draft store: applyLandingHostDocument closed on the clean path", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("keeps a clean replica row's closed:true on an incoming replica document, then follows an incoming own document's closed:false", () => {
    const seeded = baseDraft("draft-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      hostRevision: 3,
      generation: 2,
      syncedGeneration: 2,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [seeded], activeDraftId: null });

    const incomingReplica: DraftDocument = {
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

    applyLandingHostDocument(incomingReplica, EMPTY_LANDING_DRAFT_CONTENT);

    const afterReplica = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-1");
    expect(afterReplica).toBeDefined();
    // Clean replica row: `closed` is kept from the existing row, not taken
    // from the incoming document's portable value.
    expect(afterReplica?.closed).toBe(true);

    const incomingOwn: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 6,
      lastTouchedAt: 100,
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

    applyLandingHostDocument(incomingOwn, EMPTY_LANDING_DRAFT_CONTENT);

    const afterOwn = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-1");
    expect(afterOwn).toBeDefined();
    // Own document: `closed` follows the incoming portable value.
    expect(afterOwn?.closed).toBe(false);
  });
});

describe("landing draft store: collectLandingDirtyWrites excludes replica rows", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("excludes a dirty replica adopted on the given host, and includes a dirty own row adopted on it", () => {
    const dirtyReplica = baseDraft("dirty-replica", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });
    const dirtyOwn = baseDraft("dirty-own", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });

    useLandingDraftStore.setState({
      drafts: [dirtyReplica, dirtyOwn],
      activeDraftId: null,
    });

    const dirty = collectLandingDirtyWrites("host-b");
    const ids = dirty.map(({ draft }) => draft.id);

    expect(ids).not.toContain("dirty-replica");
    expect(ids).toContain("dirty-own");
  });
});
