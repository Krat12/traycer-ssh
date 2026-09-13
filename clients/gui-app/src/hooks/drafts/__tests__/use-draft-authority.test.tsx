import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { DraftClaimResult } from "@/hooks/drafts/use-draft-claim";

const claimMock = vi.hoisted(() => ({
  claim: vi.fn<(draftId: string) => Promise<DraftClaimResult>>(),
}));
const applyIncomingMock = vi.hoisted(() => ({
  apply: vi.fn<(draft: DraftDocument) => Promise<void>>(),
}));

vi.mock("@/hooks/drafts/use-draft-claim", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/drafts/use-draft-claim")>();
  return {
    draftClaimUserMessage: actual.draftClaimUserMessage,
    useDraftClaim: () => ({
      mutation: { isPending: false },
      claim: claimMock.claim,
    }),
  };
});
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  applyIncomingDraftDocument: (draft: DraftDocument): Promise<void> =>
    applyIncomingMock.apply(draft),
}));

const { useDraftAuthorityControl } =
  await import("@/hooks/drafts/use-draft-authority");

const STUB_DRAFT: DraftDocument = {
  draftId: "draft-1",
  kind: "landing",
  target: { epicId: null, chatId: null, blockId: null },
  revision: 1,
  lastTouchedAt: 1,
  workspace: null,
  ownerHostId: "host-a",
  origin: "own",
  adoption: { state: "adopted", hostId: "host-a" },
  publication: {
    status: "unpublished",
    lastPublishedAt: null,
    publishedRevision: null,
    halted: null,
  },
  portable: {
    content: { type: "doc", content: [] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

const CLIENT = {} as never;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  claimMock.claim.mockReset();
  applyIncomingMock.apply.mockReset();
});

describe("useDraftAuthorityControl", () => {
  it("owned draft: unowned is false, noteEdit never claims, ensureOwned resolves true without claiming", async () => {
    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-a",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        publication: null,
      }),
    );

    expect(view.result.current.unowned).toBe(false);

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).not.toHaveBeenCalled();

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await view.result.current.ensureOwned();
    });
    expect(resolved).toBe(true);
    expect(claimMock.claim).not.toHaveBeenCalled();
  });

  it("unowned draft: first noteEdit claims once; a second noteEdit while pending does not re-claim; a resolved ok applies the document and leaves claimError null", async () => {
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        publication: null,
      }),
    );

    expect(view.result.current.unowned).toBe(true);

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenCalledWith("draft-1");

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(STUB_DRAFT);
    });
    expect(view.result.current.claimError).toBeNull();
  });

  it("refusal: claimError is set, further noteEdit calls do not re-claim, retry re-arms, and ensureOwned re-claims (resolving false then true)", async () => {
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        publication: null,
      }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    await waitFor(() => {
      expect(view.result.current.claimError).toBe(
        "This draft was deleted elsewhere. Edits stay on this device.",
      );
    });

    // Disarmed: further edits do not hammer the host with a claim it just
    // refused.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // retry() re-arms and calls again; this attempt refuses again.
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(second.promise);
    act(() => {
      view.result.current.retry();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    let ensureResult: boolean | undefined;
    await act(async () => {
      const ensurePromise = view.result.current.ensureOwned();
      second.resolve({ status: "unavailable", reason: "not-found" });
      ensureResult = await ensurePromise;
    });
    expect(ensureResult).toBe(false);

    // ensureOwned re-arms and re-claims once more; this time it succeeds.
    const third = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(third.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);
    let finalResult: boolean | undefined;
    await act(async () => {
      const finalPromise = view.result.current.ensureOwned();
      expect(claimMock.claim).toHaveBeenCalledTimes(3);
      third.resolve({ status: "ok", draft: STUB_DRAFT });
      finalResult = await finalPromise;
    });
    expect(finalResult).toBe(true);
    expect(view.result.current.claimError).toBeNull();
  });

  it("ensureOwned joins a claim already started by noteEdit, calling claim once total", async () => {
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        publication: null,
      }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    let ensureResult: boolean | undefined;
    await act(async () => {
      const ensurePromise = view.result.current.ensureOwned();
      // Joins the in-flight claim rather than starting a second one.
      expect(claimMock.claim).toHaveBeenCalledTimes(1);
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      ensureResult = await ensurePromise;
    });
    expect(ensureResult).toBe(true);
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
  });
});
