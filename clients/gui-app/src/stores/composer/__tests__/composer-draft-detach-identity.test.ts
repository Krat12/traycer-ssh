import { afterEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { setDraftLocalEditListener } from "@/lib/drafts/draft-local-edits";

const DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

afterEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  setDraftLocalEditListener(null);
});

describe("composer draft store: detachDraftIdentity", () => {
  it("mints a fresh draftId, keeps content, clears ownership, bumps generation, and notifies the new id", () => {
    const chatId = "chat-detach";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    // Simulate a host document that adopted this row under another host.
    useComposerDraftStore.setState((state) => {
      const current = state.drafts[chatId];
      if (current === undefined) return state;
      return {
        drafts: {
          ...state.drafts,
          [chatId]: {
            ...current,
            hostRevision: 5,
            ownerHostId: "host-b",
            origin: "replica",
            publication: {
              status: "current",
              lastPublishedAt: 1,
              publishedRevision: 5,
              halted: null,
            },
          },
        },
      };
    });
    const before = useComposerDraftStore.getState().drafts[chatId];
    expect(before?.draftId).not.toBeNull();
    const draftIdBefore = before?.draftId ?? null;
    const generationBefore = before?.generation ?? 0;

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.content).toEqual(DOC);
    expect(after?.draftId).not.toBeNull();
    expect(after?.draftId).not.toBe(draftIdBefore);
    expect(after?.hostRevision).toBe(0);
    expect(after?.ownerHostId).toBeNull();
    expect(after?.origin).toBeNull();
    expect(after?.publication).toBeNull();
    expect(after?.generation).toBe(generationBefore + 1);
    expect(notified).toEqual([after?.draftId]);
  });

  it("is a no-op for a chat with no draftId", () => {
    const chatId = "chat-never-typed";
    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();
  });
});
