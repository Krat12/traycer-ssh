import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyComposerHostDocument,
  bindComposerDraftOwnership,
  collectComposerDirtyWrites,
  composerSubmittedDraftDeleteIsPending,
  EMPTY_COMPOSER_DRAFT,
  pendingSubmittedDraftDeleteHostId,
  resetComposerDetachedDraftIdsForTests,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
} from "@/lib/drafts/draft-local-edits";

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
  setDraftLocalDeleteListener(null);
  resetComposerDetachedDraftIdsForTests();
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
    if (before === undefined) throw new Error("expected a seeded row");
    const draftIdBefore = before.draftId;
    const generationBefore = before.generation;

    const notified: string[] = [];
    const notifiedOps: Array<{
      readonly op: "delete" | "edit";
      readonly draftId: string;
    }> = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
      notifiedOps.push({ op: "edit", draftId });
    });
    setDraftLocalDeleteListener((draftId) => {
      notifiedOps.push({ op: "delete", draftId });
    });

    expect(draftIdBefore).not.toBeNull();
    if (draftIdBefore === null) throw new Error("expected a draftId");

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");

    const after = useComposerDraftStore.getState().drafts[chatId];
    if (after === undefined) throw new Error("expected the row to remain");
    expect(after.content).toEqual(DOC);
    expect(after.draftId).not.toBeNull();
    expect(after.draftId).not.toBe(draftIdBefore);
    expect(after.hostRevision).toBe(0);
    expect(after.ownerHostId).toBeNull();
    expect(after.origin).toBeNull();
    expect(after.publication).toBeNull();
    expect(after.generation).toBe(generationBefore + 1);
    expect(notified).toEqual([after.draftId]);

    // The old id is registered as a pending submitted delete under the
    // host that would have owned a claim of it.
    expect(composerSubmittedDraftDeleteIsPending(draftIdBefore)).toBe(true);
    expect(pendingSubmittedDraftDeleteHostId(draftIdBefore)).toBe("host-a");

    // The delete listener fires for the OLD id before the edit listener
    // fires for the NEW id.
    expect(notifiedOps).toEqual([
      { op: "delete", draftId: draftIdBefore },
      { op: "edit", draftId: after.draftId },
    ]);
  });

  it("is a no-op for a chat with no draftId", () => {
    const chatId = "chat-never-typed";
    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");

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

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");

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
  ownerHostId: string,
): DraftDocument {
  return {
    draftId,
    kind: "chat-composer",
    target: { epicId: "epic-1", chatId, blockId: null },
    revision: 1,
    lastTouchedAt: Date.now(),
    workspace: null,
    ownerHostId,
    origin,
    adoption: { state: "adopted", hostId: ownerHostId },
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

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");
    const afterDetach = useComposerDraftStore.getState().drafts[chatId];
    const newId = afterDetach?.draftId ?? null;
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(oldId);

    // A late claim of the OLD id by the host it was retired through still
    // lands, but is refused here: the pending-delete guard keeps the row on
    // the new id and its content instead of resurfacing the old one.
    applyComposerHostDocument(
      chatComposerDocument(chatId, oldId, "own", "host-a"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe(newId);
    expect(after?.content).toEqual(DOC);
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

    applyComposerHostDocument(
      chatComposerDocument(chatId, currentId, "own", "host-remote"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.origin).toBe("own");
    expect(notified).toEqual([currentId]);
  });
});

describe("composer draft store: applyComposerHostDocument ignores a pending submitted delete", () => {
  it("ignores a chat-composer document for a draftId fenced by fenceAndDetachSubmittedDraft", () => {
    const chatId = "chat-fence-apply";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    useComposerDraftStore.setState((state) => {
      const current = state.drafts[chatId];
      if (current === undefined) return state;
      return {
        drafts: {
          ...state.drafts,
          [chatId]: { ...current, draftId: "d-old" },
        },
      };
    });

    useComposerDraftStore.getState().clearDraft(chatId);
    useComposerDraftStore
      .getState()
      .fenceAndDetachSubmittedDraft(chatId, "d-old", "host-a");

    const beforeApply = useComposerDraftStore.getState().drafts[chatId];
    expect(beforeApply?.draftId).toBeNull();
    expect(beforeApply?.content).toEqual(EMPTY_COMPOSER_DRAFT.content);

    applyComposerHostDocument(
      chatComposerDocument(chatId, "d-old", "own", "host-remote"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBeNull();
    expect(after?.content).toEqual(EMPTY_COMPOSER_DRAFT.content);
  });
});

describe("composer draft store: completeSubmittedDraftDelete after detachDraftIdentity", () => {
  it("clears the pending submitted-delete entry registered by detachDraftIdentity", () => {
    const chatId = "chat-complete-delete";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    const oldId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    expect(oldId).not.toBeNull();
    if (oldId === null || oldId === undefined) {
      throw new Error("expected a draftId before detach");
    }

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");

    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(true);

    useComposerDraftStore.getState().completeSubmittedDraftDelete(oldId);

    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(false);
    expect(pendingSubmittedDraftDeleteHostId(oldId)).toBeNull();
  });
});

describe("composer draft store: bindComposerDraftOwnership", () => {
  it("binds a replica row to the given host as own and notifies the local-edit listener", () => {
    const chatId = "chat-bind-ownership";
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
            draftId: "d-x",
            ownerHostId: "host-b",
            origin: "replica",
            hostRevision: 9,
          },
        },
      };
    });

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => {
      notified.push(draftId);
    });

    bindComposerDraftOwnership("d-x", "host-a", 1);

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.origin).toBe("own");
    expect(after?.ownerHostId).toBe("host-a");
    expect(after?.hostRevision).toBe(1);
    expect(notified).toEqual(["d-x"]);
  });
});

describe("composer draft store: applyComposerHostDocument re-arms a detached id's delete", () => {
  it("re-registers the pending delete on the new owner when a claim of a detached id commits after its first delete answered absent", () => {
    const chatId = "chat-detach-reclaim";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    const oldId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    expect(oldId).not.toBeNull();
    if (oldId === null || oldId === undefined) {
      throw new Error("expected a draftId before detach");
    }

    const deleteNotifications: string[] = [];
    setDraftLocalDeleteListener((draftId) => {
      deleteNotifications.push(draftId);
    });

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");
    const afterDetach = useComposerDraftStore.getState().drafts[chatId];
    const newId = afterDetach?.draftId ?? null;
    expect(newId).not.toBeNull();
    if (newId === null) throw new Error("expected a new draftId");

    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(true);
    expect(pendingSubmittedDraftDeleteHostId(oldId)).toBe("host-a");
    expect(deleteNotifications).toEqual([oldId]);

    // The delete answers `absent` first; the pending entry clears.
    useComposerDraftStore.getState().completeSubmittedDraftDelete(oldId);
    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(false);

    // A claim of the old id commits elsewhere, under a different host.
    applyComposerHostDocument(
      chatComposerDocument(chatId, oldId, "own", "host-b"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    // The document is not applied: the row keeps the new id and content.
    expect(after?.draftId).toBe(newId);
    expect(after?.content).toEqual(DOC);

    // The delete is re-armed, now routed to the new owner.
    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(true);
    expect(pendingSubmittedDraftDeleteHostId(oldId)).toBe("host-b");
    expect(deleteNotifications).toEqual([oldId, oldId]);
  });

  it("ignores a mismatched document for an id that was never detached", () => {
    const chatId = "chat-never-detached";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    const currentId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    expect(currentId).not.toBeNull();
    if (currentId === null || currentId === undefined) {
      throw new Error("expected a draftId");
    }

    const deleteNotifications: string[] = [];
    setDraftLocalDeleteListener((draftId) => {
      deleteNotifications.push(draftId);
    });

    const strangerId = "d-stranger";
    expect(composerSubmittedDraftDeleteIsPending(strangerId)).toBe(false);

    applyComposerHostDocument(
      chatComposerDocument(chatId, strangerId, "own", "host-b"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe(currentId);
    expect(after?.content).toEqual(DOC);
    expect(composerSubmittedDraftDeleteIsPending(strangerId)).toBe(false);
    expect(deleteNotifications).toEqual([]);
  });

  it("does not double-register or re-notify when the detached id's pending delete is still pending", () => {
    const chatId = "chat-detach-still-pending";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    const oldId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    expect(oldId).not.toBeNull();
    if (oldId === null || oldId === undefined) {
      throw new Error("expected a draftId before detach");
    }

    const deleteNotifications: string[] = [];
    setDraftLocalDeleteListener((draftId) => {
      deleteNotifications.push(draftId);
    });

    useComposerDraftStore.getState().detachDraftIdentity(chatId, "host-a");
    const afterDetach = useComposerDraftStore.getState().drafts[chatId];
    const newId = afterDetach?.draftId ?? null;
    expect(newId).not.toBeNull();
    if (newId === null) throw new Error("expected a new draftId");

    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(true);
    expect(pendingSubmittedDraftDeleteHostId(oldId)).toBe("host-a");
    expect(deleteNotifications).toEqual([oldId]);

    // The pending delete is still outstanding; a mismatched document for the
    // same detached id must not re-register or re-notify.
    applyComposerHostDocument(
      chatComposerDocument(chatId, oldId, "own", "host-b"),
    );

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe(newId);
    expect(after?.content).toEqual(DOC);
    expect(composerSubmittedDraftDeleteIsPending(oldId)).toBe(true);
    expect(pendingSubmittedDraftDeleteHostId(oldId)).toBe("host-a");
    expect(deleteNotifications).toEqual([oldId]);
  });
});
