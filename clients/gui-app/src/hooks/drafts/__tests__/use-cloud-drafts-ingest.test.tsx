import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import { appLogger } from "@/lib/logger";

const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
  settled: true,
  snapshotSeq: 0,
}));
const readMock = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ kind: string; record: unknown }>>(),
}));
const reserveMock = vi.hoisted(() => ({
  reserve: vi.fn<(draftId: string) => void>(),
}));
const ingestMock = vi.hoisted(() => ({
  ingest: vi.fn<() => Promise<void>>(),
}));
const sweepMock = vi.hoisted(() => ({
  sweep:
    vi.fn<
      (
        hostId: string,
        listed: ReadonlyMap<string, ReadonlySet<string>>,
        fenceSeq: number,
      ) => void
    >(),
}));

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    settled: directoryMock.settled,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => directoryMock.snapshotSeq,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: () => ({}),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (): Promise<{ kind: string; record: unknown }> =>
    readMock.read(),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  reserveCloudDraftIngestFence: (draftId: string): void =>
    reserveMock.reserve(draftId),
  ingestCloudDraftSummary: (): Promise<void> => ingestMock.ingest(),
  sweepAbsentCloudDraftMirrors: (
    hostId: string,
    listed: ReadonlyMap<string, ReadonlySet<string>>,
    fenceSeq: number,
  ): void => sweepMock.sweep(hostId, listed, fenceSeq),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);
// Mirrors the retry constants in use-cloud-drafts-ingest.ts. They are not
// exported, so these tests restate them - keep them in sync if the
// production values change.
const MAX_HEAD_READ_ATTEMPTS = 3;
const HEAD_READ_RETRY_BASE_MS = 2_000;

function summary(
  headSha256: string,
  overrides: Partial<CloudChatSummary> | null,
): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_1",
      chatId: "draft-1",
      ownerUserId: "user-1",
    },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
    ...overrides,
  };
}

const HEAD: DraftHeadReaderRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: { major: 1, minor: 0 },
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1,
  target: { epicId: null, chatId: null, blockId: null },
  hostLocal: { hostId: OWNER_HOST_ID, workspace: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

// The hook only needs the client to be non-null; every call it would make
// goes through the mocked reader and coordinator.
const CLIENT = { request: () => Promise.reject(new Error("unused")) };

afterEach(() => {
  directoryMock.chats = [];
  directoryMock.settled = true;
  directoryMock.snapshotSeq = 0;
  readMock.read.mockReset();
  reserveMock.reserve.mockReset();
  ingestMock.ingest.mockReset();
  sweepMock.sweep.mockReset();
  vi.useRealTimers();
});

describe("useCloudDraftsIngest", () => {
  it("re-reads the same draft when its published head changes", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // Same identity, same scope, newer head. Keyed on the identity alone this
    // second publish was skipped and the replica stayed on the old bytes.
    directoryMock.chats = [summary(DIGEST_TWO, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("reserves the ingest fence before the head read resolves, then ingests once the read settles", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The fence is reserved BEFORE the head read resolves - while the read
    // is still pending, the reserve has already happened but nothing has
    // ingested yet.
    await vi.waitFor(() => {
      expect(reserveMock.reserve).toHaveBeenCalledWith("draft-1");
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();

    for (const resolve of pending) resolve();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
  });

  it("drops a read that resolves after the effect was torn down", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    view.unmount();
    for (const resolve of pending) resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("retries a head read that throws once, then ingests once it succeeds", async () => {
    vi.useFakeTimers();
    readMock.read
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first read rejects. Let that promise settle so attemptRead's catch
    // block actually runs and arms the retry timer before the clock moves -
    // advancing first would jump straight past a timer that does not exist
    // yet.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    // Reserved once per attempt: the failed first read and the successful
    // retry each reserve the fence before their own read.
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_HEAD_READ_ATTEMPTS reads and makes no further attempt", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // Attempt 0 fails and arms the first retry (2s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    // Attempt 1 fails and arms the second retry (4s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    // Attempt 2 is the last one (MAX_HEAD_READ_ATTEMPTS = 3): it fails and
    // gives up rather than arming a third timer.
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    });
    expect(vi.getTimerCount()).toBe(0);

    // Advancing well past every backoff makes no further read.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("calls sweepAbsentCloudDraftMirrors once with every directory row's ids - foreign and own-host - and the directory's snapshot seq, when the directory is settled, and only head-ingests the foreign row", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    const ownHostSummary = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
      ownerHostId: HOST_ID,
    });
    directoryMock.chats = [summary(DIGEST_ONE, null), ownHostSummary];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).toHaveBeenCalledWith(
      HOST_ID,
      new Map([
        ["draft-1", new Set([OWNER_HOST_ID])],
        ["draft-2", new Set([HOST_ID])],
      ]),
      7,
    );
    // Only the foreign row (owned by another host) is head-ingested; the
    // own-host row is already live via `drafts.subscribe`.
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("does not call sweepAbsentCloudDraftMirrors while the directory is unsettled", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = false;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).not.toHaveBeenCalled();
  });

  it("re-attempts ingest for the same head after a rejected ingest, on the next effect run", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValueOnce(new Error("ingest failed"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    ingestMock.ingest.mockResolvedValueOnce(undefined);
    // Same head, new array reference (an equal-by-value array with a
    // different identity) so the effect re-runs.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("ingests the happy path exactly once per head across rerenders", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // Same head, new array reference each time: the key is already marked
    // ingested, so no further ingest calls should happen.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected ingest via the same backoff, then succeeds without warning on the first failure", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest
      .mockRejectedValueOnce(new Error("transient apply failure"))
      .mockResolvedValueOnce(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first ingest rejects. Let that promise settle so the catch block
    // arms the retry timer before the clock moves.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s. The
    // retry re-reads the head before calling ingest again.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("releases the key when teardown interrupts a failing apply, so the next setup asks again", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    const pending: Array<() => void> = [];
    ingestMock.ingest
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            pending.push(() => {
              reject(new Error("apply failed after teardown"));
            });
          }),
      )
      .mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(
      ({ client }) => useCloudDraftsIngest(client, HOST_ID),
      { initialProps: { client: CLIENT as never } },
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // A new client instance re-runs the effect: the old scope is torn down
    // while its apply is still in flight, and that apply then rejects.
    view.rerender({ client: { ...CLIENT } as never });
    for (const reject of pending) reject();

    // The torn-down chain must have released the key, so the fresh setup
    // ingests the same head again instead of skipping it.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("clears a pending retry timer on unmount, so it never fires a read", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("transient read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // Prove the trigger fired - the first attempt failed and armed a retry -
    // before asserting that unmounting stops it.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // The cleanup cleared the timer: letting it lapse reads no further.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });
});
