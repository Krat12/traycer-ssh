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
  bind: vi.fn<(draftId: string, hostId: string, revision: number) => void>(),
}));
const deleteClaimedRetiredLandingDraftMock = vi.hoisted(() => ({
  delete: vi.fn<(draftId: string, hostId: string) => void>(),
}));
const ownerMock = vi.hoisted(() => ({
  owner: null as string | null,
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
  bindClaimedDraftOwnership: (
    document: DraftDocument,
    hostId: string,
  ): void => {
    if (document.kind === "landing") {
      bindLandingOwnershipMock.bind(
        document.draftId,
        hostId,
        document.revision,
      );
    }
  },
  draftOwnerHostId: (): string | null => ownerMock.owner,
}));
vi.mock("@/stores/home/landing-draft-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/home/landing-draft-store")>();
  return {
    ...actual,
    deleteClaimedRetiredLandingDraft:
      deleteClaimedRetiredLandingDraftMock.delete,
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

const CHAT_COMPOSER_STUB_DRAFT: DraftDocument = {
  ...STUB_DRAFT,
  kind: "chat-composer",
  target: { epicId: "epic-1", chatId: "chat-1", blockId: null },
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
  deleteClaimedRetiredLandingDraftMock.delete.mockReset();
  ownerMock.owner = null;
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

  it("a superseded claim that commits forces a re-claim on the current host even when unowned reads false there", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The composer returns to host-a while host-b's claim is still pending.
    // Host-a's own row already names it as owner, so the render-derived
    // `unowned` guard reads false there - it alone would refuse a re-claim.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(false);

    // Host-b's (superseded) claim commits: the local row still names
    // host-a as owner while the cloud now says host-b, so the re-claim on
    // host-a must be forced past the `unowned` guard.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
  });

  it("contrast: a superseded claim that is refused does not force a re-claim once the current host already reads owned", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(false);

    // Host-b's (superseded) claim is refused: the refusal-path re-claim is
    // unforced, so the guard - already satisfied on host-a - holds and no
    // second claim starts.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });

    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a submit-started claim superseded by a forced re-claim resolves only once the forced attempt settles, and a refusal there repairs only through abandon walking to the last link", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    // The submit path starts the claim on host-b; no edit has touched it.
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The composer returns to host-a while host-b's claim is still pending.
    // Host-a's own row already names it as owner, so the render-derived
    // `unowned` guard reads false there - it alone would refuse a re-claim.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(false);

    // Host-b's (superseded) claim commits: the local row still names
    // host-a as owner while the cloud now says host-b, so the re-claim on
    // host-a is forced past the `unowned` guard. The forced attempt
    // inherits the original attempt's suppression and is linked as its
    // `chained` link.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    // The original settle chains onto the forced re-claim (attempt 2),
    // which is still pending - it must not resolve before attempt 2 does.
    expect(settleResolved).toBe(false);

    // Attempt 2 (the forced re-claim on host-a) is refused.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    // The forced attempt inherited suppression, so its own refusal handler
    // does not repair immediately - the settle promise resolves with no
    // repair having fired yet.
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(applyIncomingMock.apply).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to the last link (attempt 2), releases its
    // suppression and repairs for its draft/host - the surface is on
    // host-a showing draft-1, so the fence passes.
    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).toHaveBeenCalledTimes(1);

    // A second abandon() call is a no-op - the repair already ran once.
    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).toHaveBeenCalledTimes(1);
  });

  it("contrast: a refusal chained through a forced re-claim is not repaired by abandon once the surface has moved past the fence", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
        draftId: string;
      }) =>
        useDraftAuthorityControl({
          draftId: props.draftId,
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
          draftId: "draft-1",
        },
      },
    );

    // The submit path starts the claim on host-b; no edit has touched it.
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The composer returns to host-a while host-b's claim is still pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
      draftId: "draft-1",
    });
    expect(view.result.current.unowned).toBe(false);

    // Host-b's (superseded) claim commits, forcing a re-claim on host-a
    // (attempt 2) that the original settle chains onto.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 (the forced re-claim on host-a) is refused.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // Before abandon() runs, the surface moves to another draft/host - the
    // fence attempt 2's repair is keyed to (draft-1 on host-a) no longer
    // matches what the surface shows.
    view.rerender({
      tabHostId: "host-b",
      ownerHostId: "host-c",
      origin: "own",
      draftId: "draft-2",
    });

    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("contrast: when the forced re-claim after supersession succeeds, the original settle resolves owned and no repair fires", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(false);

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 (the forced re-claim on host-a) succeeds.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();

    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a forced re-claim starts a genuinely new attempt instead of joining the one already pending on the current host, and the fresh attempt's document wins over the stale one", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    const third = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);
    const FRESH_DRAFT: DraftDocument = { ...STUB_DRAFT, revision: 2 };

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-a",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    // Attempt 1: claimed pending on host-a.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The composer moves to host-b; attempt 2 starts there, also left
    // pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-b",
      ownerHostId: "host-c",
      origin: "own",
    });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // The composer returns to host-a. Host-a's own row already names it as
    // owner, so the render-derived `unowned` guard reads false there.
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-a",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(false);

    // Attempt 2 (host-b, superseded) commits: the local row still names
    // host-a as owner while the cloud now says host-b, so the forced
    // re-claim on host-a must start a THIRD claim call rather than joining
    // attempt 1, which is still pending under the same host-a key.
    claimMock.claim.mockReturnValueOnce(third.promise);
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });

    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(3);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(3, "draft-1");

    // Attempt 3 (the forced fresh attempt) settles first with a fresh
    // document while host-a is still current.
    await act(async () => {
      third.resolve({ status: "ok", draft: FRESH_DRAFT });
      await third.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(
        FRESH_DRAFT,
        expect.any(Function),
      );
    });
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);

    // Attempt 1 (the older, joinable attempt) settles afterward with a stale
    // document. It must not override the fresher attempt 3's already-applied
    // document: its apply is skipped entirely, since attempt 3 (a later
    // attempt number) already recorded itself as this draft's newest
    // applied attempt.
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    expect(applyIncomingMock.apply).not.toHaveBeenCalledWith(
      STUB_DRAFT,
      expect.any(Function),
    );
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("a re-claim that joins an attempt relabels every successor already chained from it, so a later successor's own re-claim cannot rejoin an ancestor under the old identity", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    const third = deferred<DraftClaimResult>();
    const fourth = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    // ownerHostId never names any host this test visits, so `unowned` reads
    // true on host-a, host-b and host-c throughout - only `tabHostId` moves.
    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-z",
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      { initialProps: { tabHostId: "host-a" } },
    );

    // Attempt 1: an independent claim on host-a via noteEdit.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The surface moves to host-b. Attempt 2: an independent claim there via
    // settleOwnership, left pending.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // The surface moves to host-c (unowned there too). Attempt 2 refuses
    // while host-c is current, so its own re-claim continuation chains a
    // fresh attempt 3 there automatically - no explicit edit needed.
    claimMock.claim.mockReturnValueOnce(third.promise);
    view.rerender({ tabHostId: "host-c" });
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await second.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(3);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(3, "draft-1");

    // The surface returns to host-b BEFORE attempt 1 (still on host-a) has
    // settled.
    view.rerender({ tabHostId: "host-b" });

    // Attempt 1 now refuses. Its re-claim, avoiding its own chain, joins
    // attempt 2 - still in flight because it awaits attempt 3 - so no new
    // claim is started (still 3 total). This join must relabel attempt 2
    // AND attempt 3 (already chained from it) with attempt 1's chain
    // identity, not just attempt 2.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(3);
    // Attempt 1 is now chained through attempt 2 into attempt 3, so its own
    // settlement is deferred - nothing has repaired yet.
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settleResolved).toBe(false);

    // The surface is on host-b when attempt 3 refuses. Its re-claim must NOT
    // join attempt 2 - after the relabel above, attempt 2 shares attempt 1's
    // chain identity, which is now an ancestor of attempt 3's re-claim - so a
    // fresh attempt 4 is started on host-b instead of a deadlocking rejoin.
    claimMock.claim.mockReturnValueOnce(fourth.promise);
    await act(async () => {
      third.resolve({ status: "unavailable", reason: "not-found" });
      await third.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(4);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(4, "draft-1");

    // The original settle (started on attempt 2) resolves only once attempt
    // 4 settles - the whole chain (1 -> 2 -> 3 -> 4) resolves together.
    await act(async () => {
      fourth.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });
    expect(settleResolved).toBe(true);
    expect(settled).not.toBeNull();
    // Attempt 4 inherited suppression down the chain, so its refusal does
    // not repair on its own - only an explicit abandon would release it.
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(claimMock.claim).toHaveBeenCalledTimes(4);
  });

  // Contrast (unforced `noteEdit` joins an in-flight attempt rather than
  // starting a new one) is already covered above by "unowned draft: first
  // noteEdit claims once with the draftId; a second noteEdit while pending
  // does not re-claim...".

  it("a re-claim does not rejoin a predecessor once relabeling has merged its chain into a shared root, starting a fresh attempt instead", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    const third = deferred<DraftClaimResult>();
    const fourth = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    // ownerHostId never names any host this test visits, so `unowned` reads
    // true on host-a, host-b and host-c throughout - only `tabHostId` moves.
    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-z",
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      { initialProps: { tabHostId: "host-a" } },
    );

    // Attempt 1: noteEdit on host-a, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The surface moves to host-b before attempt 1 settles.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-b" });

    // Attempt 1 refuses while host-b is current: its own re-claim
    // continuation chains a fresh attempt 2 there automatically (no
    // explicit edit needed). The merge points attempt 2's chain root at
    // attempt 1's - attempt 1 now awaits attempt 2.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");

    // The surface moves to host-c. Attempt 3: an independent claim there via
    // noteEdit - its own chain, not yet merged with anything.
    claimMock.claim.mockReturnValueOnce(third.promise);
    view.rerender({ tabHostId: "host-c" });
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(3);
    expect(claimMock.claim).toHaveBeenNthCalledWith(3, "draft-1");

    // The surface returns to host-b before attempt 2 or attempt 3 settles.
    view.rerender({ tabHostId: "host-b" });

    // Attempt 3 refuses while host-b is current: its re-claim joins the
    // pending attempt 2 (still in flight on host-b) rather than starting a
    // new claim - still 3 total - and the join merges attempt 3's chain
    // with attempt 1/2's, so all three now share one root.
    await act(async () => {
      third.resolve({ status: "unavailable", reason: "not-found" });
      await third.promise;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(3);

    // The surface moves to host-a. Attempt 2 refuses there: its own
    // re-claim targets the host-a key, where attempt 1 is STILL pending (it
    // is awaiting attempt 2's own settlement, which has not resolved yet).
    // After the merge above, attempt 1 and attempt 2 share the same chain
    // root, so attempt 1 is now a PREDECESSOR of this re-claim - joining it
    // would have the two await each other forever. A genuinely fresh fourth
    // attempt starts instead.
    claimMock.claim.mockReturnValueOnce(fourth.promise);
    view.rerender({ tabHostId: "host-a" });
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await second.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(4);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(4, "draft-1");

    // Nothing has repaired yet: attempts 1, 2 and 3 each deferred to a
    // successor, and attempt 4 is still pending.
    expect(repairOnEdit).not.toHaveBeenCalled();

    // Attempt 4 refuses while host-a is still current: it is the final
    // link, so its own armed repair fires - exactly once - and the whole
    // chain settles without hanging.
    await act(async () => {
      fourth.resolve({ status: "unavailable", reason: "not-found" });
      await fourth.promise;
    });
    await waitFor(() => {
      expect(repairOnEdit).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(4);
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

  it("an older success is withheld after a newer attempt's failed apply already bound ownership", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
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

    // Attempt 2 (host-b) claims ok while host-b is current, but its apply
    // throws. The claim already committed, so the catch binds ownership to
    // host-b and records attempt 2 as this draft's newest applied attempt.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });
    await waitFor(() => {
      expect(bindLandingOwnershipMock.bind).toHaveBeenCalledTimes(1);
    });
    expect(bindLandingOwnershipMock.bind).toHaveBeenCalledWith(
      "draft-1",
      "host-b",
      1,
    );
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);

    // Composer returns to host-a - the surface that started attempt 1.
    act(() => {
      view.rerender({ tabHostId: "host-a" });
    });

    // Attempt 1 (host-a) settles next: host-a is current again (so the host
    // check alone would pass), but attempt 1 is older than attempt 2's
    // already-bound apply failure, so `stillCurrent()` still reads false on
    // the generation check and `applyIncomingDraftDocument` is never called
    // for attempt 1's document. Attempt 1 committed on the CURRENT host yet
    // was outranked by another host's apply, so the row sits adopted on
    // host-b: a fresh host-a claim (attempt 3) is started for it.
    const third = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(third.promise);
    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    // Only attempt 2's apply ever ran; attempt 1's document is dropped, and
    // the fresh attempt 3 is the one that will bring host-a's ownership.
    expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    expect(bindLandingOwnershipMock.bind).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenCalledTimes(3);
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
      1,
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

  it("a successful landing claim re-arms the claimed retirement before applying the document", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const callOrder: string[] = [];
    deleteClaimedRetiredLandingDraftMock.delete.mockImplementation(() => {
      callOrder.push("delete");
    });
    applyIncomingMock.apply.mockImplementation(() => {
      callOrder.push("apply");
      return Promise.resolve();
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

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ status: "ok", draft: STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });

    expect(deleteClaimedRetiredLandingDraftMock.delete).toHaveBeenCalledTimes(
      1,
    );
    expect(deleteClaimedRetiredLandingDraftMock.delete).toHaveBeenCalledWith(
      "draft-1",
      "host-a",
    );
    expect(callOrder).toEqual(["delete", "apply"]);
  });

  it("contrast: a successful chat-composer claim never re-arms a landing retirement", async () => {
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

    await act(async () => {
      first.resolve({ status: "ok", draft: CHAT_COMPOSER_STUB_DRAFT });
      await first.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(
        CHAT_COMPOSER_STUB_DRAFT,
        expect.any(Function),
      );
    });
    expect(deleteClaimedRetiredLandingDraftMock.delete).not.toHaveBeenCalled();
  });

  it("settleOwnership on a refused attempt whose surface moved awaits the chained current-host re-claim before resolving, and resolves once that re-claim succeeds", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    // settleOwnership starts attempt 1 on host-b.
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then(() => {
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The surface moves to host-a; a replica origin keeps it unowned there
    // too, so the refusal-path re-claim's own (unforced) guard passes.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 1 refuses: it chains (unforced) into attempt 2 on host-a
    // instead of resolving on its own.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    // The settle promise has not resolved yet - it now awaits attempt 2.
    expect(settleResolved).toBe(false);

    // Attempt 2 resolves ok: the settle promise resolves along with it.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledWith(
        STUB_DRAFT,
        expect.any(Function),
      );
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("contrast: settleOwnership on the same chained refusal resolves after the current-host re-claim is refused too", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then(() => {
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 is refused instead: the settle promise still resolves
    // once it settles - a refusal there is not a hang.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
  });

  it("abandon after a chained claim resolves ok is a no-op, and repair never fires", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    // The submit path starts the claim on host-b (attempt 1).
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The composer moves to host-a; a replica origin keeps it unowned
    // there too, so the refusal-path re-claim's own (unforced) guard
    // passes.
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 1 is refused: its refusal-path re-claim on host-a (attempt 2)
    // is chained into attempt 1's own promise, so settleOwnership now
    // awaits attempt 2 too and stays pending until it settles.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 settles ok: the chain resolves owned, and settleOwnership
    // resolves along with it.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() after the chain already settled owned is a no-op.
    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("abandon after a chained claim resolves refused releases suppression and repairs exactly once", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 1 refuses and chains (unforced) into attempt 2 on host-a;
    // settleOwnership now awaits the whole chain, so it stays pending
    // until attempt 2 settles too.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 refuses too: it inherited attempt 1's suppression, so its
    // own handler does not repair on its own - the whole chain resolves
    // refused and settleOwnership resolves along with it.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to the last link (attempt 2), releases its
    // (inherited) suppression and repairs it through the chain's guard.
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

  it("a chain link's refusal that chains again after abandon defers repair to the new final link, fenced to its host", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    const third = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 1 refuses and chains (unforced) into attempt 2 on host-a.
    // settleOwnership now awaits the whole chain, so it stays pending.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // The surface moves again, to host-c, before attempt 2 settles.
    claimMock.claim.mockReturnValueOnce(third.promise);
    view.rerender({
      tabHostId: "host-c",
      ownerHostId: "host-d",
      origin: "own",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 2's refusal now chains into attempt 3 on host-c instead of
    // repairing itself: the chain grows a new final link, and the whole
    // outer promise (and settleOwnership with it) still awaits further.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await second.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(3);
    });
    expect(settleResolved).toBe(false);
    expect(repairOnEdit).not.toHaveBeenCalled();

    // Attempt 3 - the chain's new final link - refuses: it inherited
    // suppression through the chain, so its own handler does not repair,
    // and the whole cascade finally resolves refused - settleOwnership
    // resolves along with it.
    await act(async () => {
      third.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to attempt 3 - the chain's new final link - and
    // repairs, fenced to draft-1 on host-c, which the surface still shows.
    act(() => {
      settled?.abandon();
    });
    expect(repairOnEdit).toHaveBeenCalledTimes(1);
  });

  it("abandon repairs an already-refused chain link exactly once, and a second abandon is a no-op", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 1 refuses and chains (unforced) into attempt 2 on host-a;
    // settleOwnership now awaits the whole chain, so it stays pending
    // until attempt 2 settles too - it cannot resolve here on its own.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(settleResolved).toBe(false);

    // Attempt 2 refuses too: it inherited suppression from attempt 1, so
    // its own handler does not repair, and the chain resolves refused -
    // settleOwnership resolves along with it.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });
    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to the already-refused last link, releases its
    // suppression and repairs it through the chain's guard.
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

  it("a refusal chaining into an already-suppressed link must not clear its suppression, only ever add to it", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-a",
          ownerHostId: "host-c",
          origin: "replica",
        },
      },
    );
    expect(view.result.current.unowned).toBe(true);

    // An edit on host-a starts attempt 1.
    view.result.current.noteEdit();
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The surface moves to host-b, still unowned there (replica origin).
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-b",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // An edit on host-b starts attempt 2.
    view.result.current.noteEdit();
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // settleOwnership on host-b joins attempt 2 directly (no third claim)
    // and suppresses it - its refusal must not repair while a send may
    // still be deferred on it.
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // Attempt 1 refuses: it is host-fenced to host-a, which the surface has
    // left, so it chains (unforced) into the current host's claim - attempt
    // 2, already pending - instead of starting a third claim.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
    expect(repairOnEdit).not.toHaveBeenCalled();

    // Attempt 2 refuses directly - the surface never left host-b, so its
    // own reclaim is a no-op. Attempt 1's chain-in carried repairSuppressed
    // === false and must only ever ADD suppression, never clear it: attempt
    // 2's own suppression (set directly by settleOwnership above) must
    // survive, so its refusal handler must not repair here.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });
    expect(settleResolved).toBe(true);
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
    expect(repairOnEdit).not.toHaveBeenCalled();

    // abandon() walks to the last link - attempt 2, since attempt 1 chained
    // into it - releases its (preserved) suppression and repairs it once.
    // The surface is still on host-b showing draft-1, so the fence passes.
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

  it("a double-refusal chaining B -> A -> B does not deadlock: the re-claim on host-b starts a fresh attempt instead of joining its own ancestor", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    const third = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(
      (props: {
        tabHostId: string;
        ownerHostId: string;
        origin: "own" | "replica";
      }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: props.ownerHostId,
          origin: props.origin,
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      {
        initialProps: {
          tabHostId: "host-b",
          ownerHostId: "host-c",
          origin: "own",
        },
      },
    );

    // The submit path starts attempt 1 on host-b.
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The surface moves to host-a; still unowned there (replica origin).
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({
      tabHostId: "host-a",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // An edit on host-a starts its own, independent attempt 2 - a fresh
    // chain, unrelated to attempt 1's.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // Attempt 1 refuses WHILE the surface is still on host-a: it is
    // host-fenced away from its own host (host-b), so it chains (unforced)
    // into host-a's already-pending attempt 2 instead of starting a new
    // claim. No third claim call yet.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
    expect(settleResolved).toBe(false);

    // The surface moves BACK to host-b while attempt 2 - now carrying
    // attempt 1's chain - is still pending, and attempt 1 itself is still
    // registered under the host-b key (its own async body is suspended
    // awaiting attempt 2).
    view.rerender({
      tabHostId: "host-b",
      ownerHostId: "host-c",
      origin: "replica",
    });
    expect(view.result.current.unowned).toBe(true);

    // Attempt 2 refuses: host-b is current again, so its own re-claim wants
    // to run there (placement went B -> A -> B). Attempt 1 is still pending
    // under the host-b key and shares attempt 2's chain (an ancestor) -
    // joining it would have the two await each other forever, so the
    // re-claim must start a genuinely fresh attempt 3 instead.
    claimMock.claim.mockReturnValueOnce(third.promise);
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(3);
    });
    expect(settleResolved).toBe(false);

    // Attempt 3 (the fresh, non-ancestor-joining attempt) settles refused:
    // the whole cascade (1 -> 2 -> 3) resolves refused along with it, and
    // the original settle promise from step 1 resolves too.
    await act(async () => {
      third.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to the last link (attempt 3), releases its (inherited)
    // suppression and repairs it once, fenced to host-b which the surface
    // still shows.
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

  it("settleOwnership joining an attempt that already chained into a successor suppresses both links, not just the one it joined", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    // ownerHostId never names any host this test visits, so `unowned` reads
    // true on host-a and host-b throughout - only `tabHostId` moves.
    const view = renderHook(
      (props: { tabHostId: string }) =>
        useDraftAuthorityControl({
          draftId: "draft-1",
          ownerHostId: "host-z",
          origin: "own",
          tabHostId: props.tabHostId,
          client: CLIENT,
          repairOnEdit,
        }),
      { initialProps: { tabHostId: "host-b" } },
    );

    // Attempt 1: noteEdit on host-b, left pending.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The surface moves to host-a while attempt 1 is still pending.
    view.rerender({ tabHostId: "host-a" });

    // Attempt 1 refuses while host-a is current: it is host-fenced away from
    // its own host (host-b), so it chains (unforced, and at this point still
    // UNsuppressed) into a fresh attempt 2 on host-a.
    claimMock.claim.mockReturnValueOnce(second.promise);
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // The surface moves back to host-b, where attempt 1 - now carrying
    // `chained: attempt2` - is still registered (its own async body is
    // suspended awaiting attempt 2's promise).
    view.rerender({ tabHostId: "host-b" });

    // settleOwnership on host-b joins attempt 1 directly (no third claim
    // call): attempt 1 already has a successor chained from it, so this
    // must suppress attempt 1 AND attempt 2 - not just the link it joined.
    let settled: SettledOwnership | null = null;
    let settleResolved = false;
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled = s;
      settleResolved = true;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(2);

    // The surface returns to host-a - attempt 2's own host - before it
    // refuses, so its refusal resolves directly with no further chaining.
    view.rerender({ tabHostId: "host-a" });

    // Attempt 2 refuses. If only attempt 1 (the link settleOwnership joined
    // directly) had been suppressed, attempt 2's own refusal handler would
    // repair immediately here; the fix suppresses it too, via the successor
    // already chained from the joined attempt.
    await act(async () => {
      second.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settleResolved).toBe(true);
    expect(claimMock.claim).toHaveBeenCalledTimes(2);
    expect(repairOnEdit).not.toHaveBeenCalled();
    expect(settled).not.toBeNull();

    // abandon() walks to the last link (attempt 2), releases its suppression
    // and repairs it once - the surface is on host-a, attempt 2's own host,
    // so the fence passes.
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

  it("settleOwnership resolves hostId for the host it settled on when no host move happens", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-c",
        origin: "own",
        tabHostId: "host-b",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    // A holder, not a narrowed `let`: TS narrows the local to `null` after
    // the assignment and reads the field below off `never`.
    const settled: { value: SettledOwnership | null } = { value: null };
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled.value = s;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await settlePromise;
    });

    expect(settled.value).not.toBeNull();
    expect(settled.value?.hostId).toBe("host-b");
  });

  it("settleOwnership's hostId names the LAST link when the surface moves and the attempt chains into the current host's re-claim", async () => {
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
      { initialProps: { tabHostId: "host-b" } },
    );

    // settleOwnership starts the claim on host-b.
    // A holder, not a narrowed `let`: TS narrows the local to `null` after
    // the assignment and reads the field below off `never`.
    const settled: { value: SettledOwnership | null } = { value: null };
    const settlePromise = view.result.current.settleOwnership().then((s) => {
      settled.value = s;
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // The surface moves to host-a while host-b's attempt is still pending;
    // host-a is unowned too (owner is host-c throughout).
    claimMock.claim.mockReturnValueOnce(second.promise);
    view.rerender({ tabHostId: "host-a" });

    // Attempt 1 (host-b) is refused while host-a is current, so its own
    // re-claim continuation chains a fresh attempt 2 on host-a.
    await act(async () => {
      first.resolve({ status: "unavailable", reason: "not-found" });
      await first.promise;
    });
    await waitFor(() => {
      expect(claimMock.claim).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.claim).toHaveBeenNthCalledWith(2, "draft-1");

    // Attempt 2 (the chained-into re-claim on host-a) settles - the original
    // settle resolves with the LAST link's host, not the host it started on.
    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await settlePromise;
    });

    expect(settled.value).not.toBeNull();
    expect(settled.value?.hostId).toBe("host-a");
  });

  it("settleOwnership on an already-owned draft returns the noop with hostId null", async () => {
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

    // A holder, not a narrowed `let`: TS narrows the local to `null` after
    // the assignment and reads the field below off `never`.
    const settled: { value: SettledOwnership | null } = { value: null };
    await act(async () => {
      settled.value = await view.result.current.settleOwnership();
    });

    expect(claimMock.claim).not.toHaveBeenCalled();
    expect(settled.value).not.toBeNull();
    expect(settled.value?.hostId).toBeNull();
  });

  it("a claim response naming a third host as owner (moved elsewhere) is not applied, and forces a fresh re-claim on the current host", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    const second = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "replica",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    expect(view.result.current.unowned).toBe(true);

    // Attempt 1: claimed pending on host-a.
    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenNthCalledWith(1, "draft-1");

    // A third host's document applies locally while attempt 1 is still in
    // flight - the row now names host-c, neither this attempt's host nor
    // the owner it set out from.
    ownerMock.owner = "host-c";
    claimMock.claim.mockReturnValueOnce(second.promise);

    // Attempt 1 resolves ok, but the row moved elsewhere while it was in
    // flight: its document must not apply, and a fresh attempt 2 claims on
    // the current host instead.
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

    // The row is no longer moved elsewhere by the time attempt 2 settles.
    ownerMock.owner = null;

    await act(async () => {
      second.resolve({ status: "ok", draft: STUB_DRAFT });
      await second.promise;
    });

    await waitFor(() => {
      expect(applyIncomingMock.apply).toHaveBeenCalledTimes(1);
    });
    expect(applyIncomingMock.apply).toHaveBeenCalledWith(
      STUB_DRAFT,
      expect.any(Function),
    );
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("contrast: a claim response naming the pre-claim owner (a stale echo) is applied, with no forced re-claim", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "replica",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The row still names the owner this attempt set out from (host-b) - a
    // stale echo, not a move elsewhere.
    ownerMock.owner = "host-b";

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
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });

  it("contrast: a claim response naming the current host as owner (already ours) is applied, with no forced re-claim", async () => {
    const repairOnEdit = vi.fn();
    const first = deferred<DraftClaimResult>();
    claimMock.claim.mockReturnValueOnce(first.promise);
    applyIncomingMock.apply.mockResolvedValue(undefined);

    const view = renderHook(() =>
      useDraftAuthorityControl({
        draftId: "draft-1",
        ownerHostId: "host-b",
        origin: "replica",
        tabHostId: "host-a",
        client: CLIENT,
        repairOnEdit,
      }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(claimMock.claim).toHaveBeenCalledTimes(1);

    // The row already names the current host as owner - not a move
    // elsewhere.
    ownerMock.owner = "host-a";

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
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(repairOnEdit).not.toHaveBeenCalled();
  });
});
