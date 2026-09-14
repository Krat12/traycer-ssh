import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyComposerHostDocument,
  collectComposerDirtyWrites,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
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

describe("composer draft store: setSelection on a replica row", () => {
  it("updates selection without bumping generation or notifying, is excluded from dirty writes until detached", () => {
    const chatId = "chat-replica-selection";
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
    expect(before?.origin).toBe("replica");
    expect(before?.draftId).not.toBeNull();
    const generationBefore = before?.generation ?? 0;
    expect(generationBefore).toBeGreaterThan(before?.syncedGeneration ?? 0);

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    useComposerDraftStore.getState().setSelection(chatId, { from: 2, to: 4 });

    const afterSelection = useComposerDraftStore.getState().drafts[chatId];
    expect(afterSelection?.selection).toEqual({ from: 2, to: 4 });
    expect(afterSelection?.generation).toBe(generationBefore);
    expect(notified).toEqual([]);

    const dirtyBeforeDetach = collectComposerDirtyWrites().map(
      (entry) => entry.chatId,
    );
    expect(dirtyBeforeDetach).not.toContain(chatId);

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    const dirtyAfterDetach = collectComposerDirtyWrites().map(
      (entry) => entry.chatId,
    );
    expect(dirtyAfterDetach).toContain(chatId);
  });
});

function chatComposerDocument(
  chatId: string,
  draftId: string,
  origin: "own" | "replica",
): DraftDocument {
  return {
    draftId,
    kind: "chat-composer",
    target: { epicId: "epic-1", chatId, blockId: null },
    revision: 1,
    lastTouchedAt: Date.now(),
    workspace: null,
    ownerHostId: "host-remote",
    origin,
    adoption: { state: "adopted", hostId: "host-remote" },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

describe("composer draft store: applyComposerHostDocument after detachDraftIdentity", () => {
  it("ignores a chat-composer document carrying the old id once the id was re-minted", () => {
    const chatId = "chat-apply-stale-id";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
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
    const oldId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    expect(oldId).not.toBeNull();
    if (oldId === null || oldId === undefined) {
      throw new Error("expected a draftId before detach");
    }

    useComposerDraftStore.getState().detachDraftIdentity(chatId);
    const afterDetach = useComposerDraftStore.getState().drafts[chatId];
    const newId = afterDetach?.draftId ?? null;
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(oldId);

    applyComposerHostDocument(chatComposerDocument(chatId, oldId, "own"));

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe(newId);
    expect(after?.origin).toBeNull();
    expect(after?.ownerHostId).toBeNull();
    expect(after?.generation).toBe(afterDetach?.generation);
  });

  it("notifies with the current id when a chat-composer document with origin own applies onto a replica row", () => {
    const chatId = "chat-apply-current-id";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
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
    expect(before?.origin).toBe("replica");
    const currentId = before?.draftId ?? null;
    expect(currentId).not.toBeNull();
    if (currentId === null) throw new Error("expected a draftId");

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    applyComposerHostDocument(chatComposerDocument(chatId, currentId, "own"));

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.origin).toBe("own");
    expect(notified).toEqual([currentId]);
  });
});
