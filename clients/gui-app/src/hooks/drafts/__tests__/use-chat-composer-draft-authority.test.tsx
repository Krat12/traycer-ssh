import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftAuthorityControl } from "@/hooks/drafts/use-draft-authority";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const captured = vi.hoisted(() => ({
  repairOnEdit: null as (() => void) | null,
}));

const STUB_CONTROL: DraftAuthorityControl = {
  unowned: false,
  noteEdit: () => {},
  settleOwnership: () => Promise.resolve({ abandon: () => {} }),
};

vi.mock("@/hooks/drafts/use-draft-authority", () => ({
  useDraftAuthorityControl: (args: { repairOnEdit: () => void }) => {
    captured.repairOnEdit = args.repairOnEdit;
    return STUB_CONTROL;
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
});

describe("useChatComposerDraftAuthority: repairOnEdit", () => {
  it("is a no-op when the row is already this host's own", () => {
    const chatId = "chat-a";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "own",
      ownerHostId: "host-a",
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
