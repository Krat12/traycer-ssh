import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  bindClaimedDraftOwnership,
  bindComposerDraftHost,
  bindInterviewDraftHost,
  bindLandingAdoptionHost,
  cloudDraftIngestSeq,
  collectDraftMirrorDirtyWrites,
  deleteLandingDraftThroughHost,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  submitComposerDraft,
  sweepAbsentCloudDraftMirrors,
  unbindInterviewDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  notifyDraftLocalDelete,
  notifyDraftLocalEdit,
} from "@/lib/drafts/draft-local-edits";
import {
  isLandingDraftRetirementSpeculative,
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  rearmLandingDraftDelete,
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
  retireLandingDraftSpeculatively,
} from "@/lib/drafts/landing-draft-retirement";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useInterviewDraftStore } from "@/stores/composer/interview-draft-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

const HOST_ID = "host-lifecycle";
const CHAT_ID = "chat-1";
const BLOCK_ID = "block-1";
const EPIC_ID = "epic-1";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

interface HostLog {
  readonly upserts: DraftWrite[];
  readonly deletes: string[];
  rows: DraftDocument[];
  deleteFailures: number;
}

function mountSession(log: HostLog) {
  return acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: {
      request: (method: string, params: unknown) => {
        if (method === "drafts.list") {
          return Promise.resolve({
            drafts: log.rows,
            tombstones: [],
            snapshotSeq: 0,
            scopeId: null,
          });
        }
        if (method === "drafts.upsert") {
          const write = (params as { draft: DraftWrite }).draft;
          log.upserts.push(write);
          const document: DraftDocument = {
            ...write,
            ownerHostId: HOST_ID,
            origin: "own",
            adoption: { state: "adopted", hostId: HOST_ID },
            publication: {
              status: "unpublished",
              lastPublishedAt: null,
              publishedRevision: null,
              halted: null,
            },
            revision: 1,
          };
          log.rows = [document];
          return Promise.resolve({ draft: document });
        }
        if (method === "drafts.delete") {
          const draftId = (params as { draftId: string }).draftId;
          log.deletes.push(draftId);
          if (log.deleteFailures > 0) {
            log.deleteFailures -= 1;
            return Promise.reject(new Error("offline"));
          }
          log.rows = log.rows.filter((row) => row.draftId !== draftId);
          return Promise.resolve({ deleted: true });
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useInterviewDraftStore.setState({ draftsByChat: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
});

describe("interview host binding", () => {
  it("survives one duplicate view unmounting while another is still open", () => {
    useInterviewDraftStore.getState().bindTarget(CHAT_ID, BLOCK_ID, EPIC_ID);
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, BLOCK_ID, {
      pageIndex: 0,
      answers: [
        {
          questionIdentity: "q-1",
          selected: ["Beta"],
          selectedOptionIndices: [1],
          otherText: "",
          otherSelected: false,
        },
      ],
    });

    // Two live views of the same interview: split panes, or the same chat in
    // two windows.
    bindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    bindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    unbindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);

    // The surviving view still syncs. Without ref counting the first unmount
    // dropped the single entry and this collection came back empty.
    expect(
      collectDraftMirrorDirtyWrites(HOST_ID).map((entry) => entry.write.kind),
    ).toEqual(["interview"]);

    unbindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    expect(collectDraftMirrorDirtyWrites(HOST_ID)).toEqual([]);
  });
});

describe("routeLocalEdit / collectAllDirtyWrites withhold an own row the placement has left", () => {
  const HOST_A = "host-a-adopted";
  const HOST_B = "host-b-placement";

  function mountHostSession(hostId: string, log: HostLog) {
    return acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.upsert") {
            const write = (params as { draft: DraftWrite }).draft;
            log.upserts.push(write);
            const document: DraftDocument = {
              ...write,
              ownerHostId: hostId,
              origin: "own",
              adoption: { state: "adopted", hostId },
              publication: {
                status: "unpublished",
                lastPublishedAt: null,
                publishedRevision: null,
                halted: null,
              },
              revision: 1,
            };
            log.rows = [document];
            return Promise.resolve({ draft: document });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
  }

  function ownAdoptedLandingDraft(id: string) {
    return {
      id,
      content: typed("edited body"),
      selection: null,
      lastTouchedAt: 0,
      settings: null,
      composerMode: "chat" as const,
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      ...freshLandingMirrorState(),
      adoption: { state: "adopted" as const, hostId: HOST_A },
      origin: "own" as const,
      ownerHostId: HOST_A,
      generation: 3,
      syncedGeneration: 2,
    };
  }

  it("withholds noteDirty on the adopted host when the landing placement has moved to another host", async () => {
    const id = "own-withheld";
    const logA: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_A, logA);
    bindLandingAdoptionHost(HOST_B);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    // Let any scheduled (debounceMs: 0) send resolve before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logA.upserts).toEqual([]);
  });

  it("contrast: notes dirty on the adopted host when the placement still matches it", async () => {
    const id = "own-routed";
    const logA: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_A, logA);
    bindLandingAdoptionHost(HOST_A);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logA.upserts.map((write) => write.draftId)).toEqual([id]);
  });

  it("collectAllDirtyWrites skips only the row whose edit was withheld; a row dirtied before the placement moved still syncs", () => {
    const withheld = "own-skip-collect";
    const preTransition = "own-pre-transition";
    bindLandingAdoptionHost(HOST_B);
    useLandingDraftStore.setState({
      drafts: [
        ownAdoptedLandingDraft(withheld),
        ownAdoptedLandingDraft(preTransition),
      ],
      activeDraftId: null,
    });
    notifyDraftLocalEdit(withheld);

    expect(
      collectDraftMirrorDirtyWrites(HOST_A).map((entry) => entry.write.draftId),
    ).toEqual([preTransition]);
  });

  it("a withheld row stays held when the landing placement is cleared", () => {
    const id = "own-held-placement-cleared";
    bindLandingAdoptionHost(HOST_B);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });
    notifyDraftLocalEdit(id);

    // The landing mount unmounted; a tab mirror keeps host A's session
    // alive and its reconnect sweep must not deliver the held edit there.
    bindLandingAdoptionHost(null);
    expect(collectDraftMirrorDirtyWrites(HOST_A)).toEqual([]);
  });

  it("a withheld row is swept again once the placement returns to its adoption host", () => {
    const id = "own-held-then-returned";
    bindLandingAdoptionHost(HOST_B);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });
    notifyDraftLocalEdit(id);
    expect(collectDraftMirrorDirtyWrites(HOST_A)).toEqual([]);

    bindLandingAdoptionHost(HOST_A);
    expect(
      collectDraftMirrorDirtyWrites(HOST_A).map((entry) => entry.write.draftId),
    ).toEqual([id]);
  });

  it("contrast: collectAllDirtyWrites includes the row when the placement matches its adoption host", () => {
    const id = "own-include-collect";
    bindLandingAdoptionHost(HOST_A);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    expect(
      collectDraftMirrorDirtyWrites(HOST_A).map((entry) => entry.write.draftId),
    ).toEqual([id]);
  });

  it("bindLandingAdoptionHost re-queues a held edit once the placement returns to the row's adoption host, syncing exactly once", async () => {
    const id = "own-requeued-on-return";
    const logA: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_A, logA);
    bindLandingAdoptionHost(HOST_B);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logA.upserts).toEqual([]);

    bindLandingAdoptionHost(HOST_A);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logA.upserts.map((write) => write.draftId)).toEqual([id]);
  });

  it("contrast: a held edit stays held when the placement moves to a different host than the row's adoption host", async () => {
    const id = "own-still-held-other-host";
    const logA: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_A, logA);
    bindLandingAdoptionHost(HOST_B);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logA.upserts).toEqual([]);

    bindLandingAdoptionHost("host-c");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logA.upserts).toEqual([]);
  });

  it("bindLandingAdoptionHost(null) re-queues nothing and does not throw", () => {
    const id = "own-cleared-placement-no-throw";
    bindLandingAdoptionHost(HOST_B);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });
    notifyDraftLocalEdit(id);

    expect(() => bindLandingAdoptionHost(null)).not.toThrow();
    expect(collectDraftMirrorDirtyWrites(HOST_A)).toEqual([]);
  });

  it("a hold survives a round trip through its adoption host when nothing was mounted there to flush it", () => {
    const id = "own-hold-survives-unflushed-return";
    bindLandingAdoptionHost(HOST_B);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    // No session is mounted for HOST_A, so the return below re-queues onto
    // nothing and cannot flush the row clean.
    bindLandingAdoptionHost(HOST_A);
    bindLandingAdoptionHost(HOST_B);

    // If the marker had been released on the round trip (rather than only
    // at sync), this would wrongly stop withholding the row here.
    expect(collectDraftMirrorDirtyWrites(HOST_A)).toEqual([]);
  });

  it("contrast: once a return flush actually syncs the row, the marker is gone and a later edit is not spuriously withheld", async () => {
    const id = "own-marker-released-at-sync";
    const logA: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_A, logA);
    bindLandingAdoptionHost(HOST_B);

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingDraft(id)],
      activeDraftId: null,
    });

    notifyDraftLocalEdit(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logA.upserts).toEqual([]);

    // The return flushes through the mounted session, and `rememberSynced`
    // releases the marker once the row is clean.
    bindLandingAdoptionHost(HOST_A);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logA.upserts.map((write) => write.draftId)).toEqual([id]);

    // A fresh edit, made directly in the store (bumping generation past
    // syncedGeneration) while the placement still matches the adoption
    // host, must not be withheld by a marker that should already be gone.
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.id === id
          ? { ...draft, generation: draft.generation + 1 }
          : draft,
      ),
    }));

    expect(
      collectDraftMirrorDirtyWrites(HOST_A).map((entry) => entry.write.draftId),
    ).toEqual([id]);
  });
});

describe("submitComposerDraft", () => {
  it("does not tombstone a draft the user re-created during finalization", async () => {
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountSession(log);
    bindComposerDraftHost(CHAT_ID, HOST_ID);

    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("sent message"), { from: 1, to: 13 });
    const submittedDraftId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId ?? null;
    expect(submittedDraftId).not.toBeNull();

    const finalize = submitComposerDraft(CHAT_ID);
    // The keystroke that lands while the flush/delete round-trip is still in
    // flight. It must not ride the submitted id.
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("next message"), { from: 1, to: 13 });
    const nextDraftId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId;
    expect(nextDraftId).toBeDefined();
    expect(nextDraftId).not.toBe(submittedDraftId);
    await finalize;

    expect(log.deletes).toEqual([submittedDraftId]);
    // The new content is still owed to the host - the tombstone above did not
    // mark it synced.
    expect(
      collectDraftMirrorDirtyWrites(HOST_ID).map(
        (entry) => entry.write.draftId,
      ),
    ).toEqual([nextDraftId]);
  });

  it("keeps submitted text cleared across an offline delete and bootstrap replay", async () => {
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 1,
    };
    const firstSession = mountSession(log);
    bindComposerDraftHost(CHAT_ID, HOST_ID);
    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("accepted steer"), { from: 1, to: 14 });
    const draftId = readDraftId();
    await firstSession.flush([draftId]);

    await submitComposerDraft(CHAT_ID);
    const epochAfterSubmit = readDraft().resetEpoch;
    expect(readDraft().content).not.toEqual(typed("accepted steer"));
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
    ).toEqual({ hostId: HOST_ID });

    releaseDraftMirrorSession(HOST_ID);
    mountSession(log);
    await expect.poll(() => log.rows.length).toBe(0);

    expect(readDraft().content).not.toEqual(typed("accepted steer"));
    expect(readDraft().resetEpoch).toBe(epochAfterSubmit);
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
    ).toBeUndefined();
  });

  it("suppresses a late subscribe or cloud replay while deletion is fenced", async () => {
    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("submitted"), { from: 1, to: 10 });
    const draftId = readDraftId();
    store.clearDraft(CHAT_ID);
    store.fenceAndDetachSubmittedDraft(CHAT_ID, draftId, HOST_ID);
    const epochAfterSubmit = readDraft().resetEpoch;

    await applyIncomingDraftDocument(
      {
        draftId,
        kind: "chat-composer",
        target: { epicId: EPIC_ID, chatId: CHAT_ID, blockId: null },
        revision: 3,
        lastTouchedAt: 1,
        workspace: null,
        ownerHostId: HOST_ID,
        origin: "own",
        adoption: { state: "adopted", hostId: HOST_ID },
        publication: {
          status: "unpublished",
          lastPublishedAt: null,
          publishedRevision: null,
          halted: null,
        },
        portable: {
          content: typed("submitted"),
          selection: { from: 1, to: 10 },
          runSettings: null,
          composerMode: "chat",
          blobHashes: [],
          closed: false,
        },
      },
      null,
    );

    expect(readDraft().content).not.toEqual(typed("submitted"));
    expect(readDraft().resetEpoch).toBe(epochAfterSubmit);
  });
});

describe("deleteLandingDraftThroughHost", () => {
  const HOST_B = "host-b";

  function ownAdoptedLandingRow(id: string, hostId: string) {
    return {
      id,
      content: typed("own body"),
      selection: null,
      lastTouchedAt: 0,
      settings: null,
      composerMode: "chat" as const,
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      ...freshLandingMirrorState(),
      adoption: { state: "adopted" as const, hostId },
      origin: "own" as const,
      ownerHostId: hostId,
      closed: true,
    };
  }

  function mountHostSession(hostId: string, log: HostLog) {
    return acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            log.rows = log.rows.filter((row) => row.draftId !== draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
  }

  function fakeDirectClient(
    respond: (draftId: string) => Promise<{ deleted: boolean }>,
  ) {
    return {
      request: (method: string, params: unknown) => {
        if (method === "drafts.delete") {
          return respond((params as { draftId: string }).draftId);
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never;
  }

  it("no session mounted: a resolved drafts.delete({ deleted: true }) removes the row, sends { draftId }, and completes the receipt", async () => {
    const id = "direct-delete-true";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const requested: string[] = [];
    const client = fakeDirectClient((draftId) => {
      requested.push(draftId);
      return Promise.resolve({ deleted: true });
    });

    deleteLandingDraftThroughHost(id, HOST_B, client);

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);

    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(requested).toEqual([id]);
  });

  it("no session mounted: a resolved drafts.delete({ deleted: false }) unresolves the receipt owner, and a later owner document routes the delete there", async () => {
    const id = "direct-delete-false";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => Promise.resolve({ deleted: false }));

    deleteLandingDraftThroughHost(id, HOST_B, client);

    // host-b never had the row (or a claim moved it away): the receipt goes
    // back to owner-unresolved rather than completing over a row that may
    // still exist elsewhere.
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);

    // The new owner's directory head arrives next; it supplies the missing
    // delete destination instead of installing a visible row.
    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document, null);

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  it("no session mounted: a rejected drafts.delete leaves the receipt pending on host-b", async () => {
    const id = "direct-delete-rejects";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => Promise.reject(new Error("offline")));

    deleteLandingDraftThroughHost(id, HOST_B, client);

    // Let the rejected direct request settle before asserting the receipt is
    // still pending - nothing else would flip it here.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
  });

  it("a mounted session for host-b handles the delete itself; the direct client is never called", async () => {
    const id = "session-mounted-delete";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_B, log);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => {
      throw new Error(
        "must not call the direct client while a session is mounted",
      );
    });

    deleteLandingDraftThroughHost(id, HOST_B, client);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
  });

  it("a mounted session's drafts.delete answering absent unresolves the receipt via the store's deleteDraft; a later host-c document routes the delete there", async () => {
    const id = "route-local-delete-absent";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    acquireDraftMirrorSession({
      hostId: HOST_B,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            return Promise.resolve({ deleted: false });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    // Let the session's own bootstrap (list + retryPendingDeletes) finish
    // before the draft exists, so it has nothing to observe and cannot
    // race the delete this test drives below.
    await new Promise((resolve) => setTimeout(resolve, 0));

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });

    useLandingDraftStore.getState().deleteDraft(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);

    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document, null);

    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  it("a stale drafts.delete({ deleted: false }) answer after the receipt was re-armed onto a new host leaves that receipt untouched", async () => {
    const id = "stale-answer-rearmed-false";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    // A holder, not a narrowed `let`: TS narrows the local to `null` after
    // the assignment and then calls the invocation below uncallable.
    const deleteAnswer: {
      resolve: ((value: { deleted: boolean }) => void) | null;
    } = { resolve: null };
    const client = fakeDirectClient(
      () =>
        new Promise((resolve) => {
          deleteAnswer.resolve = resolve;
        }),
    );

    deleteLandingDraftThroughHost(id, HOST_B, client);
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);

    expect(rearmLandingDraftDelete(id, "host-c")).toBe(true);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");

    deleteAnswer.resolve?.({ deleted: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  it("a stale drafts.delete({ deleted: true }) answer after the receipt was re-armed onto a new host also leaves that receipt untouched", async () => {
    const id = "stale-answer-rearmed-true";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    // A holder, not a narrowed `let`: TS narrows the local to `null` after
    // the assignment and then calls the invocation below uncallable.
    const deleteAnswer: {
      resolve: ((value: { deleted: boolean }) => void) | null;
    } = { resolve: null };
    const client = fakeDirectClient(
      () =>
        new Promise((resolve) => {
          deleteAnswer.resolve = resolve;
        }),
    );

    deleteLandingDraftThroughHost(id, HOST_B, client);
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);

    expect(rearmLandingDraftDelete(id, "host-c")).toBe(true);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");

    deleteAnswer.resolve?.({ deleted: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  it("client is null and no session is mounted: the row is removed locally, the receipt stays pending on host-b, and nothing throws", () => {
    const id = "null-client-no-session";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });

    expect(() => deleteLandingDraftThroughHost(id, HOST_B, null)).not.toThrow();

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
  });
});

describe("speculative landing draft retirement", () => {
  const HOST_B = "host-b";

  function mountAbsentAnsweringSession(hostId: string, log: HostLog) {
    return acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            return Promise.resolve({ deleted: false });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
  }

  it("a document from another owner leaves a speculative receipt untouched, and creates no row", async () => {
    const id = "speculative-other-owner";
    retireLandingDraftSpeculatively(id, HOST_B);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(true);

    // The claim's refusal may have been a lost response to a commit on
    // host-b; a document from a DIFFERENT owner (host-a) says nothing about
    // that and must not redirect - or resolve - the speculative receipt.
    const document = landingCloudDocument(id, "host-a", "cloud body host-a");
    await applyIncomingDraftDocument(document, null);

    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(true);
    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);
  });

  it("a document from the speculated host resolves the receipt, still pending there", async () => {
    const id = "speculative-confirmed-owner";
    retireLandingDraftSpeculatively(id, HOST_B);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(true);

    // A document from the SAME host the receipt speculated on confirms the
    // claim did commit there.
    const document = landingCloudDocument(id, HOST_B, "cloud body host-b");
    await applyIncomingDraftDocument(document, null);

    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(false);
  });

  it("a speculative receipt on the claimed host is COMPLETED (not unresolved) when that host answers absent", async () => {
    const id = "speculative-absent-completes";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountAbsentAnsweringSession(HOST_B, log);
    // Let the session's own bootstrap (list + retryPendingDeletes) finish
    // before driving the delete below, so it cannot race it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    retireLandingDraftSpeculatively(id, HOST_B);

    notifyDraftLocalDelete(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(false);

    // Completed, not merely unresolved: a later document from another host
    // must not reopen the receipt.
    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document, null);
    expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
  });

  it("contrast: a non-speculative receipt on the same absent answer stays unresolved, not completed", async () => {
    const id = "non-speculative-absent-unresolves";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountAbsentAnsweringSession(HOST_B, log);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A confirmed-owner receipt, unlike the speculative one above.
    retireLandingDraft(id, HOST_B);
    expect(isLandingDraftRetirementSpeculative(id)).toBe(false);

    notifyDraftLocalDelete(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);

    // Unresolved, not completed: a later document from another host supplies
    // the missing delete destination instead of being ignored.
    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document, null);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  function ownAdoptedLandingRowForOrdering(id: string, hostId: string) {
    return {
      id,
      content: typed("own body"),
      selection: null,
      lastTouchedAt: 0,
      settings: null,
      composerMode: "chat" as const,
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      ...freshLandingMirrorState(),
      adoption: { state: "adopted" as const, hostId },
      origin: "own" as const,
      ownerHostId: hostId,
      closed: true,
    };
  }

  it("a session echo naming a new owner retargets a delete pending on host-a while it is still in flight (host-a's deferred answer arrives after and is ignored)", async () => {
    const id = "codex-ordering-retarget";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    const deleteAnswer: {
      resolve: ((value: { deleted: boolean }) => void) | null;
    } = { resolve: null };
    acquireDraftMirrorSession({
      hostId: HOST_B,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            return new Promise((resolve) => {
              deleteAnswer.resolve = resolve;
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRowForOrdering(id, HOST_B)],
      activeDraftId: null,
    });

    useLandingDraftStore.getState().deleteDraft(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);

    // A session echo naming host-c as the new owner arrives while host-b's
    // delete is still in flight (its `drafts.delete` answer is deferred).
    await applyIncomingDraftDocument(
      landingCloudDocument(id, "host-c", "cloud body host-c"),
      null,
    );
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");

    deleteAnswer.resolve?.({ deleted: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The stale host-b answer is ignored, not unresolved: the receipt still
    // names the retargeted host.
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-c");
  });

  it("contrast: a session echo naming the SAME host leaves the pending delete there, and its deleted:false answer then unresolves it", async () => {
    const id = "codex-ordering-same-host";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    const deleteAnswer: {
      resolve: ((value: { deleted: boolean }) => void) | null;
    } = { resolve: null };
    acquireDraftMirrorSession({
      hostId: HOST_B,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            return new Promise((resolve) => {
              deleteAnswer.resolve = resolve;
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRowForOrdering(id, HOST_B)],
      activeDraftId: null,
    });

    useLandingDraftStore.getState().deleteDraft(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);

    // A session echo naming host-b again (the same host) arrives before the
    // deferred answer.
    await applyIncomingDraftDocument(
      landingCloudDocument(id, HOST_B, "cloud body host-b"),
      null,
    );
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);

    deleteAnswer.resolve?.({ deleted: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // host-b's own answer of `deleted: false` unresolves the (now-resolved,
    // still same-host) receipt.
    expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    expect(landingDraftIsRetired(id)).toBe(true);
  });
});

function landingCloudSummary(document: DraftDocument): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_TESTDRAFTSSCOPEID000001",
      chatId: document.draftId,
      ownerUserId: "user-1",
    },
    ownerHostId: document.ownerHostId,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: "ab".repeat(32),
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

function landingCloudDocument(
  draftId: string,
  ownerHostId: string,
  text: string,
): DraftDocument {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 2,
    workspace: null,
    ownerHostId,
    origin: "replica",
    adoption: { state: "adopted", hostId: ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: typed(text),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

/**
 * An "own" landing document, as a host session's own bootstrap/live echo
 * would apply it (`origin: "own"`) - unlike `landingCloudDocument`, whose
 * `origin: "replica"` never reserves `landingOwnerAppliedSeq`. Applying this
 * through `applyIncomingDraftDocument` is what populates that reservation
 * for the admit-fence tests below.
 */
function landingOwnDocument(
  draftId: string,
  ownerHostId: string,
  text: string,
): DraftDocument {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 2,
    workspace: null,
    ownerHostId,
    origin: "own",
    adoption: { state: "adopted", hostId: ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
    portable: {
      content: typed(text),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

describe("ingestCloudDraftSummary admit fence", () => {
  it("does not overwrite a landing row this device already owns as its own", async () => {
    const id = "d1";
    // Routed through an actual apply (not a raw setState) so the fence's
    // `landingOwnerAppliedSeq` reservation is populated for this row -
    // otherwise it defaults to seq 0 and any non-negative snapshotSeq below
    // would wrongly read as "not stale".
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-a", "local own body"),
      null,
    );

    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      // Predates the own-apply above: the fence's stale check rejects it.
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("own");
    expect(row?.ownerHostId).toBe("host-a");
    expect(row?.content).toEqual(typed("local own body"));
  });

  it("applies the incoming document when no local landing row exists yet", async () => {
    const id = "d2";
    expect(
      useLandingDraftStore.getState().drafts.find((draft) => draft.id === id),
    ).toBeUndefined();

    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("replica");
    expect(row?.content).toEqual(typed("cloud body"));
  });

  it("applies the incoming document when the local landing row is already a replica", async () => {
    const id = "d3";
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("stale replica body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-b" },
          origin: "replica",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("replica");
    expect(row?.content).toEqual(typed("cloud body"));
  });

  it("applies an incoming document owned by a different host than the ingesting host, even onto a local own row", async () => {
    // Scoped fence: the local row is "own" adopted on host-a, but the
    // ingesting host is host-b (the placement auto-followed there). host-a's
    // own document is exactly what this directory legitimately supplies a
    // newer head for, so it is applied even though the row is "own" locally.
    const id = "d4";
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("local own body on host-a"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
        },
      ],
      activeDraftId: null,
    });

    const document = landingCloudDocument(id, "host-a", "cloud body host-a");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.content).toEqual(typed("cloud body host-a"));
  });

  it("does not overwrite a local own row when the ingesting host matches the row's owner host", async () => {
    // Contrast: same local own row shape, but the ingesting host IS the
    // row's owner host (host-a). The fence still blocks the apply, exactly
    // as the first admit-fence test above.
    const id = "d5";
    // Routed through an actual apply so the fence's `landingOwnerAppliedSeq`
    // reservation is populated - see the "d1" test above for why a raw
    // setState row would not exercise the stale-snapshot rejection.
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-b", "local own body on host-b"),
      null,
    );

    const document = landingCloudDocument(id, "host-a", "cloud body host-a");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
      // Predates the own-apply above: the fence's stale check rejects it.
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.content).toEqual(typed("local own body on host-b"));
  });

  it("rejects an ingest whose snapshot predates the apply that made this device own the row for the ingesting host", async () => {
    const id = "fence-stale-snapshot";
    // host-b becomes owner of this row via an apply (a host session's own
    // echo), reserving `landingOwnerAppliedSeq` for it.
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-b", "host-b own body"),
      null,
    );

    // A summary owned by a different host (host-a), but the snapshot that
    // listed it (0) was dispatched BEFORE the own-apply above: stale, so the
    // row stays own/host-b.
    const document = landingCloudDocument(id, "host-a", "cloud body host-a");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("own");
    expect(row?.ownerHostId).toBe("host-b");
    expect(row?.content).toEqual(typed("host-b own body"));
  });

  it("admits an ingest whose snapshot was dispatched after the apply that made this device own the row, adopting the new owner", async () => {
    const id = "fence-newer-snapshot";
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-b", "host-b own body"),
      null,
    );
    // A snapshot dispatched NOW, after the own-apply above.
    const snapshotSeq = cloudDraftIngestSeq();

    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.ownerHostId).toBe("host-c");
    expect(row?.origin).toBe("replica");
    expect(row?.content).toEqual(typed("cloud body host-c"));
  });

  it("admits a newer snapshot the same way over a dirty own row: local content survives, but the row adopts the new owner", async () => {
    const id = "fence-newer-snapshot-dirty";
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-b", "host-b own body"),
      null,
    );
    // Dirty the row locally (generation past syncedGeneration) before the
    // newer-owner head arrives.
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.id === id
          ? {
              ...draft,
              content: typed("locally edited body"),
              generation: draft.generation + 1,
            }
          : draft,
      ),
    }));
    const snapshotSeq = cloudDraftIngestSeq();

    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.ownerHostId).toBe("host-c");
    // Dirty rows adopt ownership without losing the uncommitted local edit.
    expect(row?.content).toEqual(typed("locally edited body"));
  });

  it("does not retarget a pending delete when the ingest's snapshot predates the apply that made this device own the row for the retired id", async () => {
    const id = "fence-stale-snapshot-retirement";
    // host-a becomes owner of this row via an apply (a host session's own
    // echo), reserving `landingOwnerAppliedSeq` for it.
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-a", "host-a own body"),
      null,
    );
    useLandingDraftStore.getState().deleteDraft(id);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-a");

    // A summary owned by a different host (host-b), but the snapshot that
    // listed it (0) was dispatched BEFORE the own-apply above: stale, so the
    // receipt must not be pulled away from host-a.
    const document = landingCloudDocument(id, "host-b", "cloud body host-b");
    await ingestCloudDraftSummary({
      hostId: "host-c",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-a");
  });

  it("retargets the pending delete when the ingest's snapshot postdates the apply that made this device own the row for the retired id", async () => {
    const id = "fence-newer-snapshot-retirement";
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-a", "host-a own body"),
      null,
    );
    useLandingDraftStore.getState().deleteDraft(id);
    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-a");

    // A snapshot dispatched NOW, after the own-apply above.
    const snapshotSeq = cloudDraftIngestSeq();
    const document = landingCloudDocument(id, "host-b", "cloud body host-b");
    await ingestCloudDraftSummary({
      hostId: "host-c",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq,
    });

    expect(pendingLandingDraftDeleteHostId(id)).toBe("host-b");
  });

  it("bindClaimedDraftOwnership migrates a replica of another host to own on the claiming host, fencing a pre-claim snapshot but admitting a newer one", async () => {
    const id = "fence-claim-migrate";
    const initialDocument = landingCloudDocument(id, "host-a", "replica body");
    await ingestCloudDraftSummary({
      hostId: "host-x",
      summary: landingCloudSummary(initialDocument),
      document: initialDocument,
      snapshotSeq: 0,
    });
    let row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("replica");
    expect(row?.ownerHostId).toBe("host-a");

    bindClaimedDraftOwnership(
      landingOwnDocument(id, "host-b", "claimed body"),
      "host-b",
    );

    row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("own");
    expect(row?.ownerHostId).toBe("host-b");

    // A pre-claim snapshot (dispatched before the claim above) still names
    // host-a as owner: stale, so the row stays own/host-b.
    const preClaimDocument = landingCloudDocument(
      id,
      "host-a",
      "pre-claim body",
    );
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(preClaimDocument),
      document: preClaimDocument,
      snapshotSeq: 0,
    });
    row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("own");
    expect(row?.ownerHostId).toBe("host-b");

    // Contrast: a snapshot dispatched after the claim is admitted, adopting
    // the new (older) owner's head.
    const snapshotSeq = cloudDraftIngestSeq();
    const postClaimDocument = landingCloudDocument(
      id,
      "host-a",
      "post-claim body",
    );
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(postClaimDocument),
      document: postClaimDocument,
      snapshotSeq,
    });
    row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("replica");
    expect(row?.ownerHostId).toBe("host-a");
    expect(row?.content).toEqual(typed("post-claim body"));
  });

  it("cross-host: a third host's ingest is fenced by an own row's apply seq regardless of which host ingests it, and admitted once the snapshot postdates it", async () => {
    const id = "fence-cross-host";
    await applyIncomingDraftDocument(
      landingOwnDocument(id, "host-b", "host-b own body"),
      null,
    );

    // host-c ingests a document owned by host-a whose snapshot predates the
    // host-b apply above: stale, so the row stays own/host-b regardless of
    // the ingesting host being neither the row's owner nor the document's
    // owner.
    const preApplyDocument = landingCloudDocument(
      id,
      "host-a",
      "pre-apply body host-a",
    );
    await ingestCloudDraftSummary({
      hostId: "host-c",
      summary: landingCloudSummary(preApplyDocument),
      document: preApplyDocument,
      snapshotSeq: 0,
    });
    let row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("own");
    expect(row?.ownerHostId).toBe("host-b");
    expect(row?.content).toEqual(typed("host-b own body"));

    // Contrast: a snapshot dispatched after the host-b apply is admitted,
    // even though the ingesting host (host-c) is neither the row's prior
    // owner nor the document's new owner.
    const snapshotSeq = cloudDraftIngestSeq();
    const postApplyDocument = landingCloudDocument(
      id,
      "host-a",
      "post-apply body host-a",
    );
    await ingestCloudDraftSummary({
      hostId: "host-c",
      summary: landingCloudSummary(postApplyDocument),
      document: postApplyDocument,
      snapshotSeq,
    });
    row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.origin).toBe("replica");
    expect(row?.ownerHostId).toBe("host-a");
    expect(row?.content).toEqual(typed("post-apply body host-a"));
  });
});

describe("sweepAbsentCloudDraftMirrors", () => {
  it("drops a clean replica adopted on host-a that is not listed, at fenceSeq 0", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-replica",
          content: typed("cloud body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "replica",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).not.toContain("sweep-replica");
  });

  it("fences a row ingested since the directory's snapshot: retained at the ingest's own seq, dropped once the fence catches up", async () => {
    const id = "sweep-fenced";
    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });
    const seqAfterIngest = cloudDraftIngestSeq();
    expect(seqAfterIngest).toBeGreaterThan(0);

    sweepAbsentCloudDraftMirrors("host-a", new Map(), seqAfterIngest - 1);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    sweepAbsentCloudDraftMirrors("host-a", new Map(), seqAfterIngest);
    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain(id);
  });

  it("drops a clean own row adopted on host-a, published, not listed, with no mirror session on host-a", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-published",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 1,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain("sweep-own-published");
  });

  it("retains a clean own row adopted on host-a whose publication is unpublished", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-unpublished",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      "sweep-own-unpublished",
    );
  });

  it("retains a clean, published own row adopted on host-a when a mirror session is mounted for host-a", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-session-mounted",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 1,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    acquireDraftMirrorSession({
      hostId: "host-a",
      client: {
        request: (method: string) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      "sweep-own-session-mounted",
    );
  });

  it("cloudDraftIngestSeq starts at 0 after reset and is 1 after one successful ingest", async () => {
    expect(cloudDraftIngestSeq()).toBe(0);

    const document = landingCloudDocument("seq-check", "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    expect(cloudDraftIngestSeq()).toBe(1);
  });

  it("reserves the ingest sequence before the apply resolves, fencing a concurrent sweep against a pre-existing clean replica row", async () => {
    const id = "sweep-fenced-before-await";
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("cloud body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "replica",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    const document = landingCloudDocument(id, "host-b", "cloud body");
    const ingest = ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
      snapshotSeq: 0,
    });

    // The sequence is reserved synchronously, before the apply's await
    // settles — not after, the way it used to be.
    expect(cloudDraftIngestSeq()).toBe(1);

    // A directory sweep whose snapshot predates this ingest (fenceSeq 0)
    // must not drop the pre-existing replica row for this draft id, even
    // though the row is not in its listed set: the just-reserved sequence
    // fences it.
    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    await ingest;
  });

  it("fences a host session's own live echo the same as a cloud-head ingest: kept at an older snapshot, dropped once its session is gone and the fence catches up", async () => {
    const id = "sweep-host-session-echo";
    const ownLandingDocument: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 2,
      workspace: null,
      ownerHostId: "host-b",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "current",
        lastPublishedAt: 1,
        publishedRevision: 1,
        halted: null,
      },
      portable: {
        content: typed("host-b's own body"),
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };

    // Mount host-b's own mirror session: its bootstrap `drafts.list` returns
    // this row as its own, adopted document - the "host session's live echo"
    // path through `applyHostDocument`, not `ingestCloudDraftSummary`.
    acquireDraftMirrorSession({
      hostId: "host-b",
      client: {
        request: (method: string) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [ownLandingDocument],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });

    await vi.waitFor(() => {
      expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
        id,
      );
    });

    // The apply reserved the fence synchronously as part of the bootstrap,
    // exactly like an `ingestCloudDraftSummary` apply does.
    expect(cloudDraftIngestSeq()).toBeGreaterThan(0);

    // An older directory snapshot (fence 0) predates this apply's reserved
    // sequence, so it must not drop the row it just installed.
    sweepAbsentCloudDraftMirrors("host-a", new Map(), 0);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    // Contrast: once host-b's session is gone and the sweep's fence has
    // caught up to the reserved sequence, the row is an own row adopted on
    // host-b with no mirror session there and IS published - it is dropped.
    releaseDraftMirrorSession("host-b");
    sweepAbsentCloudDraftMirrors("host-a", new Map(), cloudDraftIngestSeq());
    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain(id);
  });
});

function readDraft() {
  const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
  if (draft === undefined) throw new Error("missing composer draft");
  return draft;
}

function readDraftId(): string {
  const draftId = readDraft().draftId;
  if (draftId === null) throw new Error("missing composer draft id");
  return draftId;
}
