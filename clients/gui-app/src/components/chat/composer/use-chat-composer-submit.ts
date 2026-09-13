import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { blurTextEntry } from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { useChatStore } from "@/stores/composer/chat-store";
import { submitComposerDraft } from "@/lib/drafts/draft-mirror-coordinator";
import { readComposerDraftSnapshot } from "@/stores/composer/composer-draft-store";
import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  appendImageAttachmentAtoms,
  containsImageAtoms,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import {
  clearHostHeldImageHashes,
  hostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import { withHeldComposerContentImageRoots } from "@/lib/composer/composer-content-image-roots";
import {
  draftImageInliningNeeded,
  prepareDraftImageInlining,
} from "@/lib/drafts/draft-image-inlining";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { ChatSendRestore } from "@/stores/chats/chat-session-store";
import { v4 as uuidv4 } from "uuid";
import {
  buildAttachmentsFromJSONContent,
  buildSubmittedChatJSONContent,
  extractPlainTextFromComposerJSONContent,
} from "@/lib/composer/tiptap-json-content";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { decideSteerSettings } from "@/lib/chats/decide-steer-settings";
import {
  resolveSubmitDeliveryPolicy,
  type ChatComposerSubmitSource,
} from "@/lib/chats/resolve-steer-submit";
import { splitLeadingSideChatCommand } from "@/lib/chats/side-chat-command";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { Attachment } from "@/lib/composer/types";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ChatComposerSubmitInput } from "./chat-composer";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

interface UseChatComposerSubmitArgs {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly pickerStore: ComposerPickerStore;
  /**
   * Toolbar settings source. Read via `getState()` at submit time (the
   * sanctioned escape hatch) so this callback stays referentially stable
   * across model/permission/reasoning changes. This also owns the
   * model-resolution gate: an empty slug is the transient "catalog still
   * loading" marker and must never reach the wire as `model: ""` - the
   * editor's Enter handler calls this directly, bypassing the send button's
   * `canSubmit` gate, so the block is checked here.
   */
  readonly toolbarStore: ComposerToolbarStore;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  /**
   * Whether the running turn's harness supports same-turn steering, projected
   * from the host `activeTurn.sameTurnSteeringSupported` capability. Gates
   * whether a `Mod-Enter` steers or falls back to plain queueing (decision 5).
   */
  readonly steerCapable: boolean;
  /** App-wide opt-out preference (default ON - decision 17). */
  readonly steerEnabled: boolean;
  /**
   * Whether the tab's negotiated `chat.subscribe` protocol version understands
   * `after_safe_point` (host handshake minor >= 5). `false` degrades `Mod-Enter`
   * to plain-Enter queueing so a new renderer never steers a released <=1.4 host
   * that predates same-turn steering.
   */
  readonly steerProtocolSupported: boolean;
  /**
   * Reads the live active turn at submit time (not a reactive prop) so the
   * settings-drift comparison never re-creates this callback per streamed
   * token - mirrors `steerQueuedItemNow`'s live-turn read.
   */
  readonly getActiveTurnForSteer: () => ChatActiveTurn | null;
  readonly hasPendingApprovals: boolean;
  readonly sendDisabled: boolean | undefined;
  /**
   * True when the bound workspace folder can't back a turn (none linked, or
   * the host resolved no existing folder). The editor's Enter handler calls
   * this directly, bypassing the send button's `canSubmit` gate, so the block
   * is re-checked here.
   */
  readonly workspaceBlocked: boolean;
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
  /**
   * True while this chat's draft is a replica of another host's row that has
   * not been claimed. The editor is disabled, but the toolbar's send button
   * and the deferred steer confirm both reach this hook without passing the
   * editor, so the block belongs in `submitBlocked` beside the others.
   */
  readonly draftReadOnly: boolean;
  readonly onSubmitMessage:
    | ((input: ChatComposerSubmitInput) => boolean)
    | null;
  /**
   * Handles a prompt that leads with `/btw` / `/side`
   * (`lib/chats/side-chat-command.ts`): fork the chat and ask the remainder
   * there, instead of sending it here. Returning `false` keeps the composer
   * text, exactly like a refused `onSubmitMessage`. `null` where there is no
   * chat to fork; the prompt then goes through the ordinary send untouched.
   */
  readonly onSideChat: ((input: ChatComposerSideChatInput) => boolean) | null;
  /**
   * The host this composer submits to - its tab's host, which is also the host
   * its draft mirror uploaded blobs to. That equivalence is what makes
   * `drafts.readBlob` the right second leg when submit has to resolve a
   * hash-only image node's bytes.
   */
  readonly targetHostId: string | null;
  /**
   * The queued prompt this composer is currently editing, or `null` for an
   * ordinary send. Part of the submit INTENT: `onSubmitMessage`'s destination
   * is chosen from this id, so a preparation that started while editing Q must
   * not deliver into whatever the composer is pointed at when it finishes.
   */
  readonly queueEditTargetId: string | null;
}

export interface ChatComposerSideChatInput {
  /** The prompt with the command token stripped; may be empty (bare `/btw`). */
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
}

interface PendingSteerConflict {
  // The submit INTENT only - deliberately NOT the resolved `deliveryPolicy`. The
  // policy is re-resolved from the CURRENT connection/turn state at confirmation
  // time (see `onRestart`), so a host reconnect/downgrade or turn-end while the
  // dialog is open can never let a stale `after_safe_point` slip past the
  // negotiated gate.
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly restore: ChatSendRestore;
  readonly settings: ChatRunSettings;
  readonly changed: ReadonlyArray<string>;
  // The turnId this consent was DISPLAYED for. The composer persists across turn
  // replacement, so a dialog opened for turn T1 must never confirm into a
  // successor T2: at confirm time `onRestart` re-reads the live turn and only
  // steers/restarts when it is still this same turn. `null` when the drift was
  // computed against no active turn (defensive; a real interrupt_restart drift
  // always has one).
  readonly originTurnId: string | null;
}

export interface ChatComposerSubmitResult {
  readonly submitDraft: (source: ChatComposerSubmitSource) => void;
  readonly annotationPreparationPending: boolean;
  /**
   * Confirm-dialog state for a `Mod-Enter` steer whose settings differ from the
   * running turn's baked settings (decision 6). Open means the send is staged
   * behind an interrupt-and-restart confirmation; the composer text is kept
   * until the user confirms or cancels.
   */
  readonly steerConflict: {
    readonly open: boolean;
    readonly changed: ReadonlyArray<string>;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRestart: () => void;
  };
}

export function useChatComposerSubmit(
  args: UseChatComposerSubmitArgs,
): ChatComposerSubmitResult {
  const {
    taskId,
    editorRef,
    pickerStore,
    toolbarStore,
    activeTurnStatus,
    steerCapable,
    steerEnabled,
    steerProtocolSupported,
    getActiveTurnForSteer,
    hasPendingApprovals,
    sendDisabled,
    workspaceBlocked,
    imagesUnsupported,
    attachmentPreparationPending,
    draftReadOnly,
    onSubmitMessage,
    onSideChat,
    targetHostId,
    queueEditTargetId,
  } = args;
  const appendMessage = useChatStore((state) => state.appendMessage);
  // The LIVE queue-edit target, for the continuation to re-check. A captured
  // value cannot answer "is this still the submit the user asked for" - that is
  // precisely the question, and the closure froze its answer at preparation
  // time. Same shape the other latest-value bridges in this tree use.
  const queueEditTargetIdRef = useRef(queueEditTargetId);
  useEffect(() => {
    queueEditTargetIdRef.current = queueEditTargetId;
  }, [queueEditTargetId]);
  const [pendingConflict, setPendingConflict] =
    useState<PendingSteerConflict | null>(null);
  const [annotationPreparationPending, setAnnotationPreparationPending] =
    useState(false);
  const annotationPrepFlight = useRef(false);

  // Everything an ACCEPTED submit does to the composer, shared by the send and
  // the side-chat paths so a refused one leaves the text in place on both.
  const clearAcceptedDraft = useCallback((): void => {
    void submitComposerDraft(taskId);
    pickerStore.getState().reset();
    // The inherited queue-edit document is gone with the send, so its
    // host-custody claim goes with it. Hygiene only - a stale entry would leave
    // a hash bare on a later send, which is what this composer did before any
    // of this existed.
    clearHostHeldImageHashes(taskId);
    editorRef.current?.clear();
    // A rejected send leaves the text in place, and dropping the keyboard
    // there would take the user away from the message they still have to fix.
    // On a phone the keyboard covers most of the screen, so holding it open
    // after a send hides the reply the send was for.
    if (isMobileApp()) blurTextEntry();
  }, [editorRef, pickerStore, taskId]);

  const finalizeSend = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      const accepted =
        onSubmitMessage !== null
          ? onSubmitMessage(input)
          : (appendMessage(taskId, {
              role: "user",
              content: input.content,
              contentText: input.contentText,
              attachments: input.attachments,
              settings: input.settings,
            }),
            true);
      if (!accepted) return false;
      clearAcceptedDraft();
      return true;
    },
    [appendMessage, clearAcceptedDraft, onSubmitMessage, taskId],
  );

  // The conditions that block a live submit, shared verbatim between the live
  // `submitDraft` path and the deferred `onRestart` confirm so a guard added to
  // one path can never miss the other.
  const submitBlocked = useCallback(
    (): boolean =>
      activeTurnStatus === "stopping" ||
      hasPendingApprovals ||
      sendDisabled === true ||
      workspaceBlocked ||
      imagesUnsupported ||
      attachmentPreparationPending ||
      draftReadOnly,
    [
      activeTurnStatus,
      attachmentPreparationPending,
      draftReadOnly,
      hasPendingApprovals,
      imagesUnsupported,
      sendDisabled,
      workspaceBlocked,
    ],
  );

  const submitDraft = useCallback(
    (source: ChatComposerSubmitSource): void => {
      if (submitBlocked()) return;
      const toolbar = toolbarStore.getState();
      if (toolbar.selection.modelSlug.length === 0) return;
      const editor = editorRef.current;
      // A handle exists from the owner's first commit, before Tiptap's async
      // `useEditor` resolves - `getJSON()`/`clear()` silently no-op until
      // then, so a submit in that window would read the fallback initial JSON
      // and clear nothing, letting the just-submitted text resurrect once the
      // editor finishes initializing from that same stale initial content.
      if (editor === null || !editor.isReady()) return;
      if (annotationPrepFlight.current) return;
      const { annotationRecords } = readDraftSidecars(taskId);
      const editorContent = editor.getJSON();
      const contentText =
        extractPlainTextFromComposerJSONContent(editorContent);
      if (
        isEmptyComposerSubmit({
          contentText,
          editorContent,
          annotationRecords,
        })
      ) {
        return;
      }

      const submitPreparedDraft = (
        annotationImages: ReadonlyArray<AnnotationImageAtom>,
        draftImageBase64ByHash: ReadonlyMap<string, string>,
      ): void => {
        if (submitBlocked()) return;
        // Re-read the document rather than comparing the `revision` captured
        // before the async annotation-image read. `revision` bumps on every
        // keystroke, so a single character typed during that read dropped the
        // send silently; and the pre-flight capture is not what the user is
        // looking at by the time we clear the editor, so sending it would
        // discard those keystrokes. The live document is both.
        const liveContent = editor.getJSON();
        const liveContentText =
          extractPlainTextFromComposerJSONContent(liveContent);
        // Re-inline against the RE-READ document, not the captured one, for the
        // same reason. An image node that appeared during the read keeps
        // whatever payload it has: inline stays inline, and a hash nothing
        // resolved is left hash-only for the host's dangling-hash guard, which
        // is the only authority on whether that send may proceed.
        //
        // `restore.content` below deliberately keeps the UN-inlined document:
        // it is what goes back into the composer on a failed send, and the
        // composer's own shape is not the wire's. Its hashes stay rooted
        // through `chat-session-store`'s restore-content root source.
        const sendableContent = inlineHashOnlyImageBytes(
          liveContent,
          draftImageBase64ByHash,
        );
        // Re-read the sidecar array for the same reason the document is
        // re-read: an annotation attached while the crop bytes resolved is
        // what the user is looking at, and the `clearDraft` below wipes it -
        // the pre-flight capture would drop it silently. `annotationImages`
        // still covers only the records captured BEFORE that read, so a late
        // annotation sends its record without an inlined crop atom rather
        // than not being sent at all.
        const { annotationRecords: liveAnnotationRecords } =
          readDraftSidecars(taskId);
        const settings = buildChatRunSettings({
          selection: toolbar.selection,
          permission: toolbar.permission,
          reasoning: toolbar.reasoning,
          serviceTier: toolbar.serviceTier,
        });
        const submittedContent = appendImageAttachmentAtoms(
          buildSubmittedChatJSONContent(
            sendableContent,
            pickerStore.getState().knownSlashCommands,
          ),
          annotationImages,
        );
        const attachments: ReadonlyArray<Attachment> = [
          ...buildAttachmentsFromJSONContent(submittedContent),
          ...liveAnnotationRecords,
        ];

        // A `/btw` prompt never reaches this chat: the remainder is asked in a
        // fork instead. Decided AFTER chip conversion (so a typed `/btw` and a
        // picked chip read the same) and BEFORE the delivery/steer decision
        // below - a side question asked mid-turn is the whole point, and it
        // must neither steer nor queue. It sits inside the prepared-draft path
        // so it reads the same live document the send would, and the annotation
        // atoms appended above are transparent to the leading-token scan.
        if (onSideChat !== null) {
          const sideChat = splitLeadingSideChatCommand(submittedContent);
          if (sideChat !== null) {
            if (onSideChat({ content: sideChat.rest, settings })) {
              clearAcceptedDraft();
            }
            return;
          }
        }

        const deliveryPolicy = resolveSubmitDeliveryPolicy({
          source,
          activeTurnStatus,
          steerEnabled,
          steerProtocolSupported,
        });
        const sendInput: ChatComposerSubmitInput = {
          content: submittedContent,
          contentText: liveContentText,
          attachments,
          settings,
          deliveryPolicy,
          restore: {
            content: liveContent,
            browserAnnotations: liveAnnotationRecords,
          },
        };
        if (deliveryPolicy === "after_safe_point" && steerCapable) {
          const originTurn = getActiveTurnForSteer();
          const decision = decideSteerSettings(originTurn, settings);
          if (decision.kind === "interrupt_restart") {
            setPendingConflict({
              content: submittedContent,
              contentText: liveContentText,
              attachments,
              restore: {
                content: liveContent,
                browserAnnotations: liveAnnotationRecords,
              },
              settings: decision.newSettings,
              changed: decision.changed,
              originTurnId: originTurn?.turnId ?? null,
            });
            return;
          }
        }
        finalizeSend(sendInput);
      };

      // Hash-only image nodes this client still owes bytes for. A hash the
      // composer INHERITED from the host - the queued prompt a queue-edit
      // re-opened - is already an epic attachment, so it travels bare exactly
      // as it always has; re-inlining one would put megabytes back on a wire
      // that has been carrying a 64-character hash since message editing
      // existed. Keyed to this editor incarnation, so a re-created editor never
      // carries a previous one's inheritance forward.
      const incarnation = editor.getEditorIncarnation();
      const hostHeld = hostHeldImageHashes(taskId, incarnation);
      const pendingImageHashes = draftImageInliningNeeded(
        editorContent,
        hostHeld,
      );
      // The submit INTENT, captured whole. The incarnation alone cannot answer
      // "is this still the submit the user asked for": `restoreQueuedEditDraft`
      // and every other document REPLACEMENT go through `replaceDraft`, which
      // swaps the document via `resetEpoch` WITHOUT recreating the editor. So a
      // cancelled queue-edit passes an incarnation check, and the continuation
      // would then send the restored, unrelated draft into the cancelled item's
      // destination and clear it. `resetEpoch` moves on replacement and NOT on
      // a keystroke (`setSnapshot` passes `bumpResetEpoch: false`), which is
      // exactly the distinction this needs - ordinary typing must still reach
      // the live-document re-read below.
      //
      // `resetEpoch` also bumps when a HOST document replaces the row, which
      // looked at first like a source of spurious abandons on the routine
      // upsert round-trip. It is not, and the reason is worth stating exactly,
      // because an earlier version of this comment got it wrong: the composer's
      // own dirty-write ACK does not call the apply path AT ALL - it updates the
      // held revision and calls `rememberSynced` and nothing else
      // (`draft-mirror-session.ts`'s dirty-write ACK). The apply-before-remember
      // sequence belongs to `publishImmutable`, which is the STASH flow, not
      // this one. Own subscribe echoes are suppressed twice over: by the
      // local-dirty gate before the ACK, and by the equal held revision after
      // it.
      //
      // What remains is a genuine replacement - another window, a clear, or a
      // clean reconnect bootstrap. Abandoning there is the accepted behaviour,
      // and note it includes a bootstrap whose content EQUALS the current text:
      // nothing compares documents at that point, so an in-flight send can be
      // cancelled with the text unchanged. Fail-safe - no send, no clear, the
      // draft stands - and the user's next Enter goes through.
      const intent = {
        queueEditTargetId,
        resetEpoch: readComposerDraftSnapshot(taskId).resetEpoch,
      };

      if (annotationRecords.length === 0 && pendingImageHashes.length === 0) {
        submitPreparedDraft([], NO_DRAFT_IMAGE_BYTES);
        return;
      }

      annotationPrepFlight.current = true;
      setAnnotationPreparationPending(true);
      // The captured document is the only thing still naming these bytes if the
      // draft row is replaced mid-read, so it is a GC root for exactly as long
      // as the preparation runs.
      const holderId = `chat-composer-submit:${taskId}`;
      // The hold/release try/finally lives in the helper, not here: a `try`
      // without a `catch` inside a hook body is something the React Compiler
      // cannot lower, and it would cost this whole hook its memoization.
      void withHeldComposerContentImageRoots(
        holderId,
        editorContent,
        async () => {
          // Awaited BEFORE the reconcile loop, not beside it. As one leg of a
          // `Promise.all` the image leg could finish while this one was still
          // pending, and an image added during the remaining wait was never
          // attempted - the loop had already stopped looking.
          const annotationImages =
            annotationRecords.length === 0
              ? EMPTY_ANNOTATION_IMAGES
              : await resolveAnnotationImageAtoms(annotationRecords);
          if (annotationImages === null) {
            reportableErrorToast(
              "Couldn't attach the annotation image.",
              {
                description: "The crop is missing. Try attaching again.",
              },
              {
                title: "Annotation image missing",
                message: null,
                code: null,
                source: "Chat composer",
              },
            );
            return;
          }
          await prepareDraftImageInlining({
            initialHashes: pendingImageHashes,
            // Resolved inside the continuation: a draft mirror is acquired and
            // released as tiles mount, so the live session is the one that can
            // answer.
            target: draftImageByteTargetForHost(targetHostId),
            readRequiredHashes: () => {
              const live = editorRef.current;
              if (live === null) return [];
              return draftImageInliningNeeded(live.getJSON(), hostHeld);
            },
            // Synchronous with the final required-set read above it: no image
            // can arrive between that check and this send.
            commit: (draftImageBase64ByHash) => {
              // A re-created editor is a DIFFERENT document. `editor` here is
              // the handle captured before the read, so without this the send
              // would carry the destroyed editor's content while
              // `clearAcceptedDraft` cleared the live one - a stale prompt sent
              // and a live one wiped.
              if (editorRef.current?.getEditorIncarnation() !== incarnation) {
                return;
              }
              // And the same document in the same editor can still be a
              // different SUBMIT: the queue-edit destination may have been
              // cancelled or switched, or the document replaced underneath.
              if (
                queueEditTargetIdRef.current !== intent.queueEditTargetId ||
                readComposerDraftSnapshot(taskId).resetEpoch !==
                  intent.resetEpoch
              ) {
                return;
              }
              submitPreparedDraft(annotationImages, draftImageBase64ByHash);
            },
          });
        },
        () => {
          annotationPrepFlight.current = false;
          setAnnotationPreparationPending(false);
        },
      );
    },
    [
      activeTurnStatus,
      clearAcceptedDraft,
      editorRef,
      finalizeSend,
      onSideChat,
      pickerStore,
      getActiveTurnForSteer,
      steerCapable,
      steerEnabled,
      steerProtocolSupported,
      queueEditTargetId,
      submitBlocked,
      targetHostId,
      taskId,
      toolbarStore,
    ],
  );

  const onRestart = useCallback((): void => {
    if (pendingConflict === null) return;
    // The same guards the live submit path enforces (submitDraft) must block this
    // deferred confirm too. If any holds now, the consent cannot be honored -
    // dismiss the dialog (the composer text is kept, so the user can retry once it
    // clears) rather than pushing the send through the guards.
    if (submitBlocked()) {
      setPendingConflict(null);
      return;
    }
    // Bind the consent to the turn it was DISPLAYED for. The composer persists
    // across turn replacement, so if the running turn changed (a successor turn
    // is live, or none is) since the dialog opened, steering/restarting it would
    // act on consent shown for a DIFFERENT turn. Only re-resolve to a steer when
    // it is still that same turn; otherwise degrade to a plain queued send - never
    // interrupt-restart a successor turn on stale consent. (Re-resolving also
    // degrades to "auto" if the host reconnected/downgraded while the dialog was
    // open.) It was always a `mod-enter` chord that opened this dialog.
    const currentTurn = getActiveTurnForSteer();
    const sameTurn =
      currentTurn !== null &&
      pendingConflict.originTurnId !== null &&
      currentTurn.turnId === pendingConflict.originTurnId;
    const deliveryPolicy = sameTurn
      ? resolveSubmitDeliveryPolicy({
          source: "mod-enter",
          activeTurnStatus,
          steerEnabled,
          steerProtocolSupported,
        })
      : "auto";
    if (
      finalizeSend({
        content: pendingConflict.content,
        contentText: pendingConflict.contentText,
        attachments: pendingConflict.attachments,
        settings: pendingConflict.settings,
        deliveryPolicy,
        restore: pendingConflict.restore,
      })
    ) {
      setPendingConflict(null);
    }
  }, [
    finalizeSend,
    pendingConflict,
    activeTurnStatus,
    steerEnabled,
    steerProtocolSupported,
    getActiveTurnForSteer,
    submitBlocked,
  ]);

  const onOpenChange = useCallback((open: boolean): void => {
    if (open) return;
    setPendingConflict(null);
  }, []);

  return {
    submitDraft,
    annotationPreparationPending,
    steerConflict: {
      open: pendingConflict !== null,
      changed: pendingConflict?.changed ?? [],
      onOpenChange,
      onRestart,
    },
  };
}

/**
 * The synchronous path's empty resolution map. Shared so the "nothing to
 * re-inline" send reads as the deliberate case it is rather than allocating a
 * map per keystroke-free submit.
 */
const NO_DRAFT_IMAGE_BYTES: ReadonlyMap<string, string> = new Map<
  string,
  string
>();

/** Shared empty for the no-annotation branch, so it allocates nothing. */
const EMPTY_ANNOTATION_IMAGES: ReadonlyArray<AnnotationImageAtom> = [];

interface ComposerDraftSidecars {
  readonly annotationRecords: ReadonlyArray<BrowserAnnotationRecord>;
}

/**
 * The draft's non-document sidecar array, read live. Both the pre-flight read
 * and the post-async finalize go through here so they can never diverge.
 */
function readDraftSidecars(taskId: string): ComposerDraftSidecars {
  const draft = readComposerDraftSnapshot(taskId);
  return { annotationRecords: draft.browserAnnotations };
}

function isEmptyComposerSubmit(input: {
  readonly contentText: string;
  readonly editorContent: JsonContent;
  readonly annotationRecords: ReadonlyArray<BrowserAnnotationRecord>;
}): boolean {
  return (
    input.contentText.trim().length === 0 &&
    !containsImageAtoms(input.editorContent) &&
    input.annotationRecords.length === 0
  );
}

type AnnotationImageAtom = {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly b64content: string;
  readonly hash: string;
};

async function resolveAnnotationImageAtoms(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): Promise<ReadonlyArray<AnnotationImageAtom> | null> {
  const atoms: AnnotationImageAtom[] = [];
  for (const record of records) {
    const sessionBytes = sessionImageBytes(record.imageHash);
    const bytes =
      sessionBytes ??
      // An IndexedDB open/transaction failure is "the crop is not available",
      // the same outcome as a missing key - and it must reach the caller as
      // `null` rather than a rejection, which nothing above awaits with a
      // `catch` and which would silently abandon the submit with no toast.
      (await getImageBytes(record.imageHash).catch((error: unknown) => {
        appLogger.error(
          "[chat-composer] annotation image read failed",
          { imageHash: record.imageHash },
          error,
        );
        return undefined;
      })) ??
      null;
    if (bytes === null) return null;
    atoms.push({
      id: uuidv4(),
      fileName: record.imageFileName,
      mimeType: "image/png",
      size: bytes.byteLength,
      b64content: bytesToBase64(bytes),
      hash: record.imageHash,
    });
  }
  return atoms;
}
