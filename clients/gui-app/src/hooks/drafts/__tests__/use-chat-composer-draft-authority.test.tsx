import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";

const captured = vi.hoisted(() => ({
  repairOnEdit: null as (() => void) | null,
}));

const claimMock = vi.hoisted(() => ({
  claim: vi.fn<(draftId: string) => void>(),
}));

// A thin stand-in for the real `useDraftAuthorityControl`: `unowned` is
// derived the same way the real hook derives it (via the real
// `draftRequiresClaim`), and `noteEdit` records into `claimMock.claim`
// instead of driving a real RPC — the mount-effect cases below only need to
// see whether the wrapper's effect called `noteEdit()` on its own, not the
// full claim/apply/repair machinery, which `use-draft-authority.test.tsx`
// already covers against the real hook.
vi.mock("@/hooks/drafts/use-draft-authority", () => ({
  useDraftAuthorityControl: (args: {
    readonly draftId: string | null;
    readonly ownerHostId: string | null;
    readonly origin: "own" | "replica" | null;
    readonly tabHostId: string | null;
    readonly repairOnEdit: () => void;
  }) => {
    captured.repairOnEdit = args.repairOnEdit;
    const unowned =
      args.tabHostId !== null &&
      args.draftId !== null &&
      draftRequiresClaim(args.ownerHostId, args.origin, args.tabHostId);
    return {
      unowned,
      noteEdit: () => {
        claimMock.claim(args.draftId ?? "");
      },
      settleOwnership: () => Promise.resolve({ abandon: () => {} }),
    };
  },
}));

const { useChatComposerDraftAuthority } =
  await import("@/hooks/drafts/use-chat-composer-draft-authority");

const DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function seedComposerDraft(
  chatId: string,
  overrides: {
    readonly draftId: string;
    readonly origin: "own" | "replica";
    readonly ownerHostId: string;
    /**
     * Whether the row is left dirty (`generation > syncedGeneration`) after
     * seeding. `setSnapshot` already leaves a fresh row dirty by default
     * (generation 1, syncedGeneration 0); pass `false` to mark it synced.
     */
    readonly dirty: boolean;
  },
): void {
  useComposerDraftStore.getState().setSnapshot(chatId, DOC, null);
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[chatId];
    if (current === undefined) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          draftId: overrides.draftId,
          origin: overrides.origin,
          ownerHostId: overrides.ownerHostId,
          syncedGeneration: !overrides.dirty
            ? current.generation
            : current.syncedGeneration,
        },
      },
    };
  });
}

afterEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  captured.repairOnEdit = null;
  claimMock.claim.mockReset();
});

describe("useChatComposerDraftAuthority: repairOnEdit", () => {
  it("is a no-op when the row is already this host's own", () => {
    const chatId = "chat-a";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "own",
      ownerHostId: "host-a",
      dirty: true,
    });

    renderHook(() =>
      useChatComposerDraftAuthority({
        chatId,
        tabHostId: "host-a",
        client: null,
      }),
    );

    expect(captured.repairOnEdit).not.toBeNull();
    captured.repairOnEdit?.();

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe("d1");
  });

  it("detaches the identity when the row is a replica owned by another host", () => {
    const chatId = "chat-b";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "replica",
      ownerHostId: "host-b",
      dirty: true,
    });

    renderHook(() =>
      useChatComposerDraftAuthority({
        chatId,
        tabHostId: "host-a",
        client: null,
      }),
    );

    expect(captured.repairOnEdit).not.toBeNull();
    captured.repairOnEdit?.();

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).not.toBe("d1");
    expect(after?.draftId).not.toBeNull();
  });
});

describe("useChatComposerDraftAuthority: mount re-arm", () => {
  it("a dirty replica row re-arms at mount: claim is invoked once with no noteEdit() call from the test", () => {
    const chatId = "chat-c";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "replica",
      ownerHostId: "host-b",
      dirty: true,
    });

    renderHook(() =>
      useChatComposerDraftAuthority({
        chatId,
        tabHostId: "host-a",
        client: null,
      }),
    );

    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).toHaveBeenCalledWith("d1");
  });

  it("contrast: a clean replica row does not claim at mount", () => {
    const chatId = "chat-d";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "replica",
      ownerHostId: "host-b",
      dirty: false,
    });

    renderHook(() =>
      useChatComposerDraftAuthority({
        chatId,
        tabHostId: "host-a",
        client: null,
      }),
    );

    expect(claimMock.claim).not.toHaveBeenCalled();
  });

  it("contrast: a dirty row this host already owns does not claim at mount", () => {
    const chatId = "chat-e";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "own",
      ownerHostId: "host-a",
      dirty: true,
    });

    renderHook(() =>
      useChatComposerDraftAuthority({
        chatId,
        tabHostId: "host-a",
        client: null,
      }),
    );

    expect(claimMock.claim).not.toHaveBeenCalled();
  });
});
