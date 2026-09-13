import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  createComposerEditorIncarnation,
  type ComposerEditorIncarnation,
} from "@/lib/composer/composer-editor-incarnation";
import {
  __resetHostHeldImageHashesForTests,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const HASH_ONLY_IMAGE_HASH = "a".repeat(64);
const HOST_HELD_HASH = "b".repeat(64);
const UNRESOLVABLE_HASH = "c".repeat(64);
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function hashOnlyImageNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
    },
  };
}

function docWithHashOnlyImage(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      hashOnlyImageNode(hash),
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
    ],
  };
}

function docWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function fakeEditor(
  content: JsonContent,
  incarnation: ComposerEditorIncarnation | null,
): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    getEditorIncarnation: () => incarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

/** A mutable handle whose document AND `clear()` call count can be observed and, for one test, whose editor incarnation can be swapped mid-flight. */
function mutableFakeEditor(
  initial: JsonContent,
  initialIncarnation: ComposerEditorIncarnation | null,
): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  readonly setIncarnation: (next: ComposerEditorIncarnation | null) => void;
  clearCount: number;
} {
  let content = initial;
  let incarnation = initialIncarnation;
  const state = {
    handle: {
      ...fakeEditor(initial, initialIncarnation),
      getJSON: () => content,
      getEditorIncarnation: () => incarnation,
      clear: () => {
        state.clearCount += 1;
      },
    },
    setJSON: (next: JsonContent) => {
      content = next;
    },
    setIncarnation: (next: ComposerEditorIncarnation | null) => {
      incarnation = next;
    },
    clearCount: 0,
  };
  return state;
}

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "draft-image-submit",
    values: {
      permission: "supervised",
      selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      draftReadOnly: false,
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: null,
      targetHostId: null,
      queueEditTargetId: null,
    }),
  );
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
  __resetHostHeldImageHashesForTests();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

describe("useChatComposerSubmit draft images", () => {
  it("takes the synchronous path with no hash-only node: onSubmitMessage runs before any microtask turn", () => {
    const taskId = "chat-sync";
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithText("hello"), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // No `act(async ...)`, no `waitFor` - if this needed a microtask turn the
    // assertion below would still see zero calls.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
  });

  it("re-inlines a hash-only node injected into the document", async () => {
    const taskId = "chat-inline";
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_ONLY_IMAGE_HASH
        ? Promise.resolve(IMAGE_BYTES)
        : Promise.resolve(null),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).not.toBeNull();
    expect(atoms[0]?.hash).toBeNull();
  });

  it("leaves an unresolvable hash-only node hash-only, and still sends", async () => {
    const taskId = "chat-unresolvable";
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(UNRESOLVABLE_HASH), null),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // Nothing rejects the send client-side; the host's guard is the authority.
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(UNRESOLVABLE_HASH);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("sends a host-held hash bare instead of re-inlining it", () => {
    const taskId = "chat-host-held";
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(taskId, incarnation, [HOST_HELD_HASH]);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(docWithHashOnlyImage(HOST_HELD_HASH), incarnation),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // A host-held hash needs no resolution at all: the send is synchronous.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.hash).toBe(HOST_HELD_HASH);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("a keystroke during byte resolution is neither dropped nor cleared", async () => {
    const taskId = "chat-keystroke-during-resolve";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH),
      null,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(editor.clearCount).toBe(0);

    // A keystroke lands while the byte read is in flight: both the text and
    // the (still hash-only, at this point) image move.
    const typedDoc: JsonContent = {
      type: "doc",
      content: [
        hashOnlyImageNode(HASH_ONLY_IMAGE_HASH),
        { type: "paragraph", content: [{ type: "text", text: "typed" }] },
      ],
    };
    act(() => {
      editor.setJSON(typedDoc);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.contentText).toBe("typed");
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
    // Cleared exactly once, and only after the send.
    expect(editor.clearCount).toBe(1);
  });

  it("abandons the send and does not clear the editor when the incarnation changes mid-flight", async () => {
    const taskId = "chat-incarnation-change";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const firstIncarnation = createComposerEditorIncarnation();
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(HASH_ONLY_IMAGE_HASH),
      firstIncarnation,
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // The editor was torn down and recreated while bytes were resolving, and
    // the user typed into the new one before the stale read came back.
    const typedAfterRecreate = docWithText("still here");
    act(() => {
      editor.setIncarnation(createComposerEditorIncarnation());
      editor.setJSON(typedAfterRecreate);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
    // The composer is not left stuck "preparing" - the `finally` ran.
    expect(result.current.annotationPreparationPending).toBe(false);
    // And the user's text is still there to retry with, not silently dropped.
    expect(editor.handle.getJSON()).toEqual(typedAfterRecreate);
  });
});
