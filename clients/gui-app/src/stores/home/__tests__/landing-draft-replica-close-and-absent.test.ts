import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropForeignLandingMirrorsAbsent,
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import { setDraftLocalEditListener } from "@/lib/drafts/draft-local-edits";

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
