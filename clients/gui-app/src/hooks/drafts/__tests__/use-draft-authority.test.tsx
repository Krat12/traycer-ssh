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

vi.mock("@/hooks/drafts/use-draft-claim", () => ({
  useDraftClaim: () => ({
    mutation: { isPending: false },
    claim: claimMock.claim,
  }),
}));
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
  it("owned draft: unowned is false, noteEdit never claims, settleOwnership resolves without claiming", async () => {
    const repairOnEdit = vi.fn();
    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-a",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    expect(view.result.current.unowned).toBe(false);

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.settleOwnership();
    });
    expect(claimMock.claim).not.toHaveBeenCalled();
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("unowned draft: first noteEdit claims once with the draftId; a second noteEdit while pending does not re-claim; a resolved ok applies the document and never runs repair", async () => {
    const repairOnEdit = vi.fn();
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
        repairOnEdit,
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
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("refusal: repairOnEdit is called exactly once and the document is never applied", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
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
      expect(repairOnEdit).toHaveBeenCalledTimes(1);
    });
    expect(applyIncomingMock.apply).not.toHaveBeenCalled();
  });

  it("settleOwnership called while a noteEdit-started claim is pending joins it (claim called once) and resolves after it settles", async () => {
    const repairOnEdit = vi.fn();
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
        repairOnEdit,
      }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    let settled = false;
    const settlePromise = view.result.current.settleOwnership().then(() => {
      settled = true;
    });
    // Joins the in-flight claim rather than starting a second one.
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settled).toBe(true);
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a claim pending for draft-a is not joined when the hook re-renders for draft-b; resolving A's promise does not repair B", async () => {
    const repairOnEditA = vi.fn();
    const repairOnEditB = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: { draftId: string; repairOnEdit: () => void }) =>
        useDraftAuthorityControl({
          draftId: props.draftId,
          ownerHostId: "host-b",
          origin: "own",
          tabHostId: "host-a",
          client: CLIENT,
          repairOnEdit: props.repairOnEdit,
        }),
      { initialProps: { draftId: "draft-a", repairOnEdit: repairOnEditA } },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-a");

    // Re-render for a different, unowned draft while A's claim is pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ draftId: "draft-b", repairOnEdit: repairOnEditB });

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-b");

    // A's promise settling must not affect B's outcome/repair.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    expect(repairOnEditA).not.toHaveBeenCalled();
    expect(repairOnEditB).not.toHaveBeenCalled();
  });

  it("an edit that joins a submit-started claim does not fork under the send", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    // The submit path starts the claim; no edit has touched it yet.
    act(() => {
      void view.result.current.settleOwnership();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Two edits join the same pending claim.
    act(() => {
      view.result.current.noteEdit();
    });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    // The claim was joined by the submit's own settleOwnership, which
    // suppresses repair on refusal - even though an edit also joined it.
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
  });

  it("a submit-started claim that succeeds after an edit joined it does not repair", async () => {
    const repairOnEdit = vi.fn();
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
        repairOnEdit,
      }),
    );

    act(() => {
      void view.result.current.settleOwnership();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    act(() => {
      view.result.current.noteEdit();
    });
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
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("an edit-armed claim that a submit later joins does not fork", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    // An edit starts the claim and arms the repair.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    let settled = false;
    const settlePromise = view.result.current.settleOwnership().then(() => {
      settled = true;
    });
    // Joins the in-flight claim rather than starting a second one.
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settled).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
  });

  it("a host change during a pending claim starts that host's own claim", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-c",
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      { initialProps: { tabHostId: "host-a" } },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Composer moves to another host while host-a's claim is still pending;
    // the draft is still unowned (owner is host-c) on host-b.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // A's claim is superseded by B's: A's refusal must not repair the
    // draft out from under the host the composer now shows.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    expect(repairOnEdit).not.toHaveBeenCalled();

    // B is the current host; its refusal repairs.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await second.promise;
    });

    await waitFor(() => {
      expect(repairOnEdit).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
  });

  it("a superseded host's refusal never repairs after the current host succeeds", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-c",
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      { initialProps: { tabHostId: "host-a" } },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Composer moves to another host while host-a's claim is still pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // B (the current host) succeeds first.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);

    // A's (superseded) refusal arrives afterward and must not repair.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
  });

  it("returning to a draft with a pending claim joins it", async () => {
    const repairOnEditA = vi.fn();
    const repairOnEditB = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: { draftId: string; repairOnEdit: () => void }) =>
        useDraftAuthorityControl({
          draftId: props.draftId,
          ownerHostId: "host-b",
          origin: "own",
          tabHostId: "host-a",
          client: CLIENT,
          repairOnEdit: props.repairOnEdit,
        }),
      { initialProps: { draftId: "draft-a", repairOnEdit: repairOnEditA } },
    );

    // Claims draft-a; the claim stays pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-a");

    // Move to an unowned draft-b without editing it.
    view.rerender({ draftId: "draft-b", repairOnEdit: repairOnEditB });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Return to draft-a: the still-pending claim is joined, not re-started.
    view.rerender({ draftId: "draft-a", repairOnEdit: repairOnEditA });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    await waitFor(() => {
      expect(repairOnEditA).toHaveBeenCalledTimes(1);
    });
    expect(repairOnEditB).not.toHaveBeenCalled();
  });

  it("settleOwnership on a refusal resolves and does not call repairOnEdit", async () => {
    const repairOnEdit = vi.fn();
    claimMock.claim.mockResolvedValueOnce({
      status: "unavailable",
      reason: "not-found",
    });

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "own",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    await act(async () => {
      await view.result.current.settleOwnership();
    });

    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(applyIncomingMock.apply).not.toHaveBeenCalled();
  });
});
