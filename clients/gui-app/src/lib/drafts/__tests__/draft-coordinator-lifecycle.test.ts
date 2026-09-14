import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  bindComposerDraftHost,
  bindInterviewDraftHost,
  collectDraftMirrorDirtyWrites,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  submitComposerDraft,
  unbindInterviewDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
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
