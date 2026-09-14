import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { DraftClaimResult } from "@/hooks/drafts/use-draft-claim";
import type { SettledOwnership } from "@/hooks/drafts/use-draft-authority";

const claimMock = vi.hoisted(() => ({
  claim: vi.fn<(draftId: string) => Promise<DraftClaimResult>>(),
}));
const applyIncomingMock = vi.hoisted(() => ({
  apply: vi.fn<(draft: DraftDocument, admit: () => boolean) => Promise<void>>(),
}));
const bindLandingOwnershipMock = vi.hoisted(() => ({
  bind: vi.fn<(draftId: string, hostId: string) => void>(),
}));

vi.mock("@/hooks/drafts/use-draft-claim", () => ({
  useDraftClaim: () => ({
    mutation: { isPending: false },
    claim: claimMock.claim,
  }),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  applyIncomingDraftDocument: (
    draft: DraftDocument,
    admit: () => boolean,
  ): Promise<void> => applyIncomingMock.apply(draft, admit),
}));
vi.mock("@/stores/home/landing-draft-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/home/landing-draft-store")>();
  return {
    ...actual,
    bindLandingDraftOwnership: bindLandingOwnershipMock.bind,
  };
});

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
  bindLandingOwnershipMock.bind.mockReset();
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
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(
        STUB_DRAFT,
        expect.any(Function),
      );
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
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(
        STUB_DRAFT,
        expect.any(Function),
      );
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

  it("a superseded host's success is not applied", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

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

    // Composer moves to another host while host-a's claim (A) is pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // B (the current host) succeeds first and applies its document.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });

    // A's (superseded) success arrives afterward and must not apply its
    // document - the row would roll back to a host the composer left.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
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

  it("the apply fence reports a host swap that happens during the apply", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    const captured: { admit: (() => boolean) | null } = { admit: null };
    applyIncomingMock.apply.mockImplementation((_draft, admit) => {
      captured.admit = admit;
      return Promise.resolve();
    });

    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-b",
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

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalled();
    });

    expect(captured.admit).not.toBeNull();
    expect(captured.admit?.()).toBe(true);

    // The composer moves to another host during the apply's own async
    // blob reads - the coordinator re-asks this same `admit` right before
    // its store mutation, and it must now report the swap.
    act(() => {
      view.rerender({ tabHostId: "host-b" });
    });

    await waitFor(() => {
      expect(captured.admit?.()).toBe(false);
    });
  });

  it("an older success is dropped once a newer attempt has applied", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

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

    // Attempt 1: started on host-a, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Composer moves to host-b; attempt 2 starts there, also left pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // Attempt 2 (host-b) settles with an applied success while host-b is
    // still current.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });

    // Composer returns to host-a - the surface that started attempt 1.
    act(() => {
      view.rerender({ tabHostId: "host-a" });
    });

    // Attempt 1 (host-a) settles next: host-a is current again, but attempt 1
    // is older than the already-applied attempt 2, so its document must not
    // be applied and no repair fires.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("an older success survives a newer attempt's refusal", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

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

    // Attempt 1: started on host-a, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Composer moves to host-b; attempt 2 starts there, also left pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // Composer returns to host-a - the surface that started attempt 1.
    act(() => {
      view.rerender({ tabHostId: "host-a" });
    });

    // Attempt 2 (host-b) is refused: host-b is no longer current, so its
    // refusal must not repair the draft out from under host-a.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await second.promise;
    });
    expect(repairOnEdit).not.toHaveBeenCalled();

    // Attempt 1 (host-a) succeeds afterward: the refusal never applied
    // anything, so attempt 1's older success still stands and applies.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("abandon after a refused settle runs an edit-armed repair once", async () => {
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

    // noteEdit starts the claim and arms the repair on it.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // settleOwnership joins the same claim and suppresses the armed repair
    // until it is explicitly abandoned.
    let settled: SettledOwnership | null = null;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
    });

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    // Suppressed: the refusal must not repair on its own while a settle is
    // waiting to decide whether the attempt is abandoned.
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).toHaveBeenCalledTimes(1);

    // A second abandon() is a no-op - the repair already ran once.
    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).toHaveBeenCalledTimes(1);
  });

  it("abandon after a successful settle is a no-op", async () => {
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

    let settled: SettledOwnership | null = null;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
    });

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });
    expect(settled).not.toBeNull();

    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a claim dropped for a surface move to another host starts that host's claim via the latest noteEdit, and the dropped claim's success is not applied", async () => {
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

    // Claim 1: noteEdit on host-a, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The surface moves to host-b without any edit there yet - the draft is
    // still unowned on host-b too (owner is host-c).
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Claim 1 resolves ok while host-b is current: it is superseded, so its
    // document must not apply, and the continuation starts host-b's own
    // claim via the latest `noteEdit` rather than stranding the edit on
    // host-a.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");
    expect(applyIncomingMock.apply).not.toHaveBeenCalled();
    expect(repairOnEdit).not.toHaveBeenCalled();
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

  it("a draft-and-host switch does not claim the new draft", async () => {
    const repairOnEditA = vi.fn();
    const repairOnEditB = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        draftId: string;
        ownerHostId: string;
        tabHostId: string;
        repairOnEdit: () => void;
      }) =>
        useDraftAuthorityControl({
          draftId: props.draftId,
          ownerHostId: props.ownerHostId,
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit: props.repairOnEdit,
        }),
      {
        initialProps: {
          draftId: "draft-a",
          ownerHostId: "host-b",
          tabHostId: "host-a",
          repairOnEdit: repairOnEditA,
        },
      },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-a");

    // The surface switches to a different, unowned draft AND a different
    // host, with no edit on the new surface.
    view.rerender({
      draftId: "draft-b",
      ownerHostId: "host-c",
      tabHostId: "host-b",
      repairOnEdit: repairOnEditB,
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // draft-a's claim (made through host-a) resolving ok must not claim
    // draft-b: the pending claim's continuation only ever re-claims its own
    // draft, never the one the surface has since moved to.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(applyIncomingMock.apply).not.toHaveBeenCalled();
    expect(repairOnEditA).not.toHaveBeenCalled();
    expect(repairOnEditB).not.toHaveBeenCalled();
  });

  it("a host move during the apply re-claims on the current host", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    const applyDeferred = deferred<void>();
    const capturedApply: { admit: (() => boolean) | null } = { admit: null };
    applyIncomingMock.apply.mockImplementation((_draft, admit) => {
      capturedApply.admit = admit;
      return applyDeferred.promise;
    });

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

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalled();
    });
    expect(capturedApply.admit).not.toBeNull();

    // The composer moves to another host while the apply's own async blob
    // reads are still in flight.
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(second.promise);
    act(() => {
      view.rerender({ tabHostId: "host-b" });
    });
    expect(capturedApply.admit?.()).toBe(false);

    // The apply resolves after the move: `stillCurrent()` now reads false,
    // so the continuation re-claims on the current host via the latest
    // `noteEdit` instead of leaving the edit stranded on host-a.
    await act(async () => {
      applyDeferred.resolve();
      await applyDeferred.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");
  });

  it("a failed apply binds ownership", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockRejectedValueOnce(
      new Error("blob read failed"),
    );

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

    let settled: SettledOwnership | null = null;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settled).not.toBeNull();
    expect(bindLandingOwnershipMock.bind).toHaveBeenCalledTimes(1);
    expect(bindLandingOwnershipMock.bind).toHaveBeenCalledWith(
      "draft-1",
      "host-a",
    );
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("apply rejects after a host move: bindLandingDraftOwnership is not called, and the latest noteEdit re-claims on the current host", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockRejectedValueOnce(
      new Error("blob read failed"),
    );

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
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // Composer moves to another host before host-a's claim resolves; the
    // draft is still unowned there too (owner is host-c).
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Host-a's claim resolves ok, but its apply rejects while host-b is
    // current: `stillCurrent()` reads false at the catch, so the refused
    // apply must not bind ownership for the stale host-a attempt. Instead
    // the latest `noteEdit` (bound to the now-current host-b) re-claims.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");
    expect(bindLandingOwnershipMock.bind).not.toHaveBeenCalled();
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a refused claim on a left host re-claims on the current host", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
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

    // Claim 1: noteEdit on host-a, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The surface moves to host-b without any edit there yet - the draft is
    // still unowned on host-b too (owner is host-c).
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // Claim 1 is refused while host-b is current: the refusal is host-fenced
    // to host-a, which the surface has since left, so it repairs nothing.
    // Instead the latest `noteEdit` (bound to the now-current host-b)
    // starts host-b's own claim for the same draft.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");
    expect(repairOnEdit).not.toHaveBeenCalled();
  });
});
