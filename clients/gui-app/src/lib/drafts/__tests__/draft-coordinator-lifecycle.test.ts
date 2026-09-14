import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  bindComposerDraftHost,
  bindInterviewDraftHost,
  bindLandingAdoptionHost,
  cloudDraftIngestSeq,
  collectDraftMirrorDirtyWrites,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  submitComposerDraft,
  sweepAbsentCloudDraftMirrors,
  unbindInterviewDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { notifyDraftLocalEdit } from "@/lib/drafts/draft-local-edits";
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

describe("ingestCloudDraftSummary admit fence", () => {
  it("does not overwrite a landing row this device already owns as its own", async () => {
    const id = "d1";
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("local own body"),
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

    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
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
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("local own body on host-b"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-b" },
          origin: "own",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    const document = landingCloudDocument(id, "host-a", "cloud body host-a");
    await ingestCloudDraftSummary({
      hostId: "host-b",
      summary: landingCloudSummary(document),
      document,
    });

    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === id);
    expect(row?.content).toEqual(typed("local own body on host-b"));
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

    sweepAbsentCloudDraftMirrors("host-ingesting", new Set(), 0);

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
    });
    const seqAfterIngest = cloudDraftIngestSeq();
    expect(seqAfterIngest).toBeGreaterThan(0);

    sweepAbsentCloudDraftMirrors("host-a", new Set(), seqAfterIngest - 1);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    sweepAbsentCloudDraftMirrors("host-a", new Set(), seqAfterIngest);
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

    sweepAbsentCloudDraftMirrors("host-ingesting", new Set(), 0);

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

    sweepAbsentCloudDraftMirrors("host-ingesting", new Set(), 0);

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

    sweepAbsentCloudDraftMirrors("host-ingesting", new Set(), 0);

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
    });

    // The sequence is reserved synchronously, before the apply's await
    // settles — not after, the way it used to be.
    expect(cloudDraftIngestSeq()).toBe(1);

    // A directory sweep whose snapshot predates this ingest (fenceSeq 0)
    // must not drop the pre-existing replica row for this draft id, even
    // though the row is not in its listed set: the just-reserved sequence
    // fences it.
    sweepAbsentCloudDraftMirrors("host-ingesting", new Set(), 0);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    await ingest;
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
