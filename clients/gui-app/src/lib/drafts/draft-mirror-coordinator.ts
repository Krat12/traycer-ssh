import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { appLogger, describeLogError } from "@/lib/logger";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import {
  forgetBlobUnsupportedHost,
  putDraftBlobs,
  putDraftBlobsForWrite,
  readDraftBlobsIntoLocalStore,
  resetDraftBlobTransportForTests,
} from "./draft-blob-transport";
import {
  blobHashesFromContent,
  blobHashesOfDocument,
} from "./draft-write-codec";
import { draftKindIsHostBound } from "./draft-portability";
import { isDraftsCapabilityMissing } from "./draft-capability";

import { interviewDraftBindingKey } from "./draft-ids";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import {
  adoptLandingDraft,
  applyLandingHostDelete,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  deleteLandingDraftOnHost,
  dropForeignLandingMirrorsAbsent,
  dropLandingAbsentFromList,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  applyComposerHostDelete,
  applyComposerHostDocument,
  collectComposerDirtyWrites,
  composerDraftIsDirty,
  composerDraftRememberSynced,
  composerSubmittedDraftDeleteIsPending,
  dropComposerAbsentFromList,
  findComposerChatIdByDraftId,
  pendingSubmittedDraftDeleteHostId,
  pendingSubmittedDraftDeleteIdsForHost,
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  applyInterviewHostDelete,
  applyInterviewHostDocument,
  collectInterviewDirtyWrites,
  dropInterviewAbsentFromList,
  findInterviewByDraftId,
  interviewDraftIsDirty,
  interviewDraftRememberSynced,
} from "@/stores/composer/interview-draft-store";
import {
  applyNewChatHostDelete,
  applyNewChatHostDocument,
  collectNewChatDirtyWrites,
  dropNewChatAbsentFromList,
  useNewConversationModalStore,
  findNewChatByDraftId,
  newChatDraftIsDirty,
  newChatDraftRememberSynced,
} from "@/stores/epics/new-conversation-modal-store";
import {
  composerDraftWrite,
  interviewDraftWrite,
  landingTarget,
  newChatTarget,
  requiredChatTarget,
  stashDraftWrite,
} from "./draft-write-codec";
import type {
  PromptStashEntry,
  PromptStashImageBlob,
} from "@/lib/composer/prompt-stash-codec";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
  setDraftLocalFlushListener,
  setLandingPlacementHostReader,
} from "./draft-local-edits";
import {
  DraftMirrorSession,
  type DraftDeleteOutcome,
  type DraftDirtyWrite,
  type DraftMirrorSink,
} from "./draft-mirror-session";
import type { DraftMirrorTiming } from "./draft-mirror-timing";
import {
  completeLandingDraftDelete,
  isLandingDraftRetirementSpeculative,
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  pendingLandingDraftDeleteIdsForHost,
  retireLandingDraft,
  resolveLandingDraftRetirementOwner,
  unresolveLandingDraftRetirementOwner,
} from "./landing-draft-retirement";

type SessionEntry = {
  readonly session: DraftMirrorSession;
  refCount: number;
};

const sessions = new Map<string, SessionEntry>();
const sessionClients = new Map<string, HostRequester<HostRpcRegistry>>();
const knownLandingDraftIds = new Set<string>();
const cloudScopeIdByHost = new Map<string, string | null>();
const cloudScopeListeners = new Set<() => void>();

function notifyCloudScopeListeners(): void {
  for (const listener of cloudScopeListeners) listener();
}

function setCloudScopeId(hostId: string, scopeId: string | null): void {
  const previous = cloudScopeIdByHost.get(hostId) ?? null;
  if (previous === scopeId) return;
  cloudScopeIdByHost.set(hostId, scopeId);
  notifyCloudScopeListeners();
}

export function subscribeDraftsCloudScope(listener: () => void): () => void {
  cloudScopeListeners.add(listener);
  return () => {
    cloudScopeListeners.delete(listener);
  };
}

const composerHostByChatId = new Map<string, string>();
const interviewHostByKey = new Map<string, string>();
/**
 * Live binds per `(chat, block, host)`. Two duplicate views of the same
 * interview mount the same binding, and unmounting either one used to delete
 * the single map entry - leaving the surviving view unsynchronized until it
 * remounted. Counted, so the entry outlives every view but the last.
 */
const interviewBindingRefs = new Map<string, number>();
const newChatHostByEpicId = new Map<string, string>();

function interviewBindingRefKey(bindingKey: string, hostId: string): string {
  return `${bindingKey}\u0000${hostId}`;
}

/** Placement host that may lazily adopt landing drafts (decision #9). */
let landingAdoptionHostId: string | null = null;
/**
 * Ordering fence for the cloud-directory absence sweep: every landing
 * document apply - a cloud-head ingest or a host session's live echo -
 * takes the next sequence number when it STARTS, and a directory snapshot
 * records the sequence current when its request was DISPATCHED. A row
 * applied after that (by another mount, through another host) is not
 * absent from that snapshot in any sense the snapshot can attest to.
 */
let cloudIngestSeq = 0;
const cloudIngestSeqByDraft = new Map<string, number>();
/**
 * Own landing rows whose edit `routeLocalEdit` withheld because their
 * adoption host is not the current placement (an auto-follow). Only these
 * are held back from the old host's dirty sweep: a row dirtied BEFORE the
 * placement moved still finishes syncing there.
 */
const heldLandingEdits = new Set<string>();

/** Host that last published or ingested each stash id. */
const stashHostById = new Map<string, string>();
/** Ids applied from a host list/subscribe, keyed `hostId:entryId`. */
const stashSeenOnHost = new Set<string>();

function stashSeenKey(hostId: string, entryId: string): string {
  return `${hostId}:${entryId}`;
}

export function bindLandingAdoptionHost(hostId: string | null): void {
  landingAdoptionHostId = hostId;
  if (hostId === null) return;
  // A placement that returns to a host re-queues the edits withheld from
  // it while it was elsewhere: the composer's edit watcher no-ops for a row
  // the current host already owns, and a mirror session kept mounted by a
  // tab runs no bootstrap on the return, so nothing else would schedule
  // the write. The rows are still dirty; only the notification was held.
  const rows = useLandingDraftStore.getState().drafts;
  for (const draftId of heldLandingEdits) {
    const row = rows.find((draft) => draft.id === draftId);
    if (row === undefined) {
      heldLandingEdits.delete(draftId);
      continue;
    }
    if (row.adoption.state !== "adopted" || row.adoption.hostId !== hostId) {
      continue;
    }
    // The marker stays until the edit SYNCS (`rememberSynced`): a placement
    // that leaves again before this flush must find the row still held, or
    // the old host's sweep would send the edit while the placement is gone.
    sessions.get(hostId)?.session.noteDirty(draftId);
  }
}

/**
 * Upsert-once a local stash capture onto `hostId`. No-op when no
 * session is mounted (offline / old host) — IndexedDB remains the
 * local tier.
 */
export function publishStashEntry(
  hostId: string,
  entry: PromptStashEntry,
): Promise<void> {
  stashHostById.set(entry.id, hostId);
  const session = sessions.get(hostId)?.session;
  if (session === undefined) return Promise.resolve();
  return session.publishImmutable(
    stashDraftWrite({
      draftId: entry.id,
      content: entry.content,
      blobHashes: entry.blobHashes,
      createdAt: entry.createdAt,
    }),
  );
}

/**
 * Owner-authorized delete after restore-consume. Idempotent: a second
 * device's consume that lost the race still restored locally; the
 * host answers `deleted: false`.
 */
export async function deleteStashEntryOnHost(
  hostId: string | null,
  entryId: string,
): Promise<void> {
  const bound = hostId ?? stashHostById.get(entryId) ?? null;
  if (bound === null) return;
  const session = sessions.get(bound)?.session;
  if (session === undefined) return;
  const dropped = await session.deleteOnHost(entryId);
  if (dropped) stashHostById.delete(entryId);
}

export function draftsCloudScopeId(hostId: string): string | null {
  return (
    cloudScopeIdByHost.get(hostId) ??
    sessions.get(hostId)?.session.cloudScopeId() ??
    null
  );
}

export async function consumeStashOnHost(
  hostId: string | null,
  entryId: string,
): Promise<void> {
  const bound = hostId ?? stashHostById.get(entryId) ?? null;
  if (bound === null) {
    await deleteStashEntryOnHost(null, entryId);
    return;
  }
  const knownHost = stashHostById.get(entryId);
  if (knownHost === undefined || knownHost === bound) {
    await deleteStashEntryOnHost(bound, entryId);
    return;
  }
  const client = sessionClients.get(bound);
  if (client !== undefined) {
    try {
      const claimed = await client.request("drafts.claim", {
        draftId: entryId,
      });
      if (claimed.status === "ok" || claimed.status === "already-owned") {
        stashHostById.set(entryId, bound);
      }
    } catch {
      // Delete still runs: same-host consume and a lost claim race
      // are both idempotent (`deleted: false`).
    }
  }
  await deleteStashEntryOnHost(bound, entryId);
}

async function ingestStashDocument(
  document: DraftDocument,
  images: ReadonlyMap<string, PromptStashImageBlob>,
): Promise<void> {
  if (document.kind !== "stash-entry") return;
  stashHostById.set(document.draftId, document.ownerHostId);
  stashSeenOnHost.add(stashSeenKey(document.ownerHostId, document.draftId));
  try {
    await usePromptStashStore.getState().ingestRemote(
      {
        id: document.draftId,
        createdAt: document.portable.createdAt,
        content: document.portable.content,
        blobHashes: document.portable.blobHashes,
      },
      images,
    );
  } catch (error: unknown) {
    appLogger.warn("[draft-mirror] stash ingest failed", {
      error: describeLogError(error),
    });
  }
}

function dropStashEntry(draftId: string): void {
  const hostId = stashHostById.get(draftId);
  stashHostById.delete(draftId);
  if (hostId !== undefined) {
    stashSeenOnHost.delete(stashSeenKey(hostId, draftId));
  }
  usePromptStashStore
    .getState()
    .dropRemote(draftId)
    .catch((error: unknown) => {
      appLogger.warn("[draft-mirror] stash drop failed", {
        error: describeLogError(error),
      });
    });
}

function dropStashAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
): void {
  for (const [entryId, boundHost] of [...stashHostById.entries()]) {
    if (boundHost !== hostId) continue;
    if (!stashSeenOnHost.has(stashSeenKey(hostId, entryId))) continue;
    if (listedIds.has(entryId)) continue;
    dropStashEntry(entryId);
  }
}

export function bindComposerDraftHost(chatId: string, hostId: string): void {
  composerHostByChatId.set(chatId, hostId);
}

export function unbindComposerDraftHost(chatId: string, hostId: string): void {
  if (composerHostByChatId.get(chatId) === hostId) {
    composerHostByChatId.delete(chatId);
  }
}

export function bindInterviewDraftHost(
  chatId: string,
  blockId: string,
  hostId: string,
): void {
  const key = interviewDraftBindingKey(chatId, blockId);
  const refKey = interviewBindingRefKey(key, hostId);
  interviewBindingRefs.set(refKey, (interviewBindingRefs.get(refKey) ?? 0) + 1);
  interviewHostByKey.set(key, hostId);
}

export function unbindInterviewDraftHost(
  chatId: string,
  blockId: string,
  hostId: string,
): void {
  const key = interviewDraftBindingKey(chatId, blockId);
  const refKey = interviewBindingRefKey(key, hostId);
  const remaining = (interviewBindingRefs.get(refKey) ?? 0) - 1;
  if (remaining > 0) {
    interviewBindingRefs.set(refKey, remaining);
    return;
  }
  interviewBindingRefs.delete(refKey);
  if (interviewHostByKey.get(key) === hostId) interviewHostByKey.delete(key);
}

export function bindNewChatDraftHost(epicId: string, hostId: string): void {
  newChatHostByEpicId.set(epicId, hostId);
}

export function unbindNewChatDraftHost(epicId: string, hostId: string): void {
  if (newChatHostByEpicId.get(epicId) === hostId) {
    newChatHostByEpicId.delete(epicId);
  }
}

const sink: DraftMirrorSink = {
  isDirty(draftId) {
    return (
      landingDraftIsDirty(draftId) ||
      composerDraftIsDirty(draftId) ||
      interviewDraftIsDirty(draftId) ||
      newChatDraftIsDirty(draftId)
    );
  },
  isDeletePending(draftId) {
    return (
      landingDraftIsRetired(draftId) ||
      composerSubmittedDraftDeleteIsPending(draftId)
    );
  },
  pendingDeleteIdsForHost(hostId) {
    return [
      ...pendingLandingDraftDeleteIdsForHost(hostId),
      ...pendingSubmittedDraftDeleteIdsForHost(hostId),
    ];
  },
  settleDelete(hostId, draftId, outcome) {
    // Landing: only while the receipt still names this host, and `absent`
    // re-routes rather than completes. Composer: a retired submitted id is
    // done once the host has answered anything but a failure.
    settleLandingDeleteOutcome(draftId, hostId, outcome);
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
  },
  applyUpsert(document) {
    return applyHostDocument(document, null);
  },
  applyDelete(draftId) {
    // A tombstone can arrive while the first landing upsert awaits its images,
    // before there is any local row for applyLandingHostDelete to remove.
    if (knownLandingDraftIds.has(draftId)) retireLandingDraft(draftId, null);
    completeLandingDraftDelete(draftId);
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
    applyLandingHostDelete(draftId);
    applyComposerHostDelete(draftId);
    applyInterviewHostDelete(draftId);
    applyNewChatHostDelete(draftId);
    dropStashEntry(draftId);
  },
  collectDirtyWrites(hostId) {
    return Promise.resolve(collectAllDirtyWrites(hostId));
  },
  rememberSynced(draftId, hostRevision, collectedGeneration) {
    landingDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    // A held landing edit is released only once the generation it belongs
    // to has synced; a route or a placement return does not release it.
    if (heldLandingEdits.has(draftId) && !landingDraftIsDirty(draftId)) {
      heldLandingEdits.delete(draftId);
    }
    composerDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    interviewDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    newChatDraftRememberSynced(draftId, hostRevision, collectedGeneration);
  },
  async prepareWrite(hostId, write) {
    const client = sessionClients.get(hostId);
    if (client === undefined) return write;
    const confirmed = await putDraftBlobsForWrite(hostId, client, write);
    rememberLandingBlobsOnHost(write.draftId, confirmed);
    return write;
  },
  dropAbsentFromList(hostId, listedIds) {
    dropLandingAbsentFromList(hostId, listedIds);
    dropComposerAbsentFromList(hostId, listedIds, composerHostByChatId);
    dropInterviewAbsentFromList(hostId, listedIds, interviewHostByKey);
    dropNewChatAbsentFromList(hostId, listedIds, newChatHostByEpicId);
    dropStashAbsentFromList(hostId, listedIds);
  },
  adoptUnadoptedLandingDrafts(hostId, wanted) {
    return adoptUnadoptedLandingDraftsForHost(hostId, wanted);
  },
  applyCloudScope(hostId, scopeId) {
    setCloudScopeId(hostId, scopeId);
  },
};

function rejectRetiredLandingDocument(document: DraftDocument): boolean {
  if (document.kind !== "landing" || !landingDraftIsRetired(document.draftId))
    return false;
  // Desktop may restore content before it has recovered host adoption.
  // The first owner document supplies the missing delete destination, never
  // a replacement visible row. ACKed receipts cannot be rearmed here.
  resolveLandingDraftRetirementOwner(document.draftId, document.ownerHostId);
  if (pendingLandingDraftDeleteHostId(document.draftId) !== null) {
    routeLocalDelete(document.draftId);
  }
  return true;
}

/**
 * `admit` is re-asked immediately before the store mutation, after the blob
 * reads have awaited: a caller whose reason to apply can lapse meanwhile (a
 * claim made through a host the surface has since left) fences here rather
 * than only before the await. `null` applies unconditionally.
 */
async function applyHostDocument(
  document: DraftDocument,
  admit: (() => boolean) | null,
): Promise<void> {
  if (document.kind === "landing") {
    knownLandingDraftIds.add(document.draftId);
    // The absence-sweep fence is reserved here, synchronously at the start
    // of EVERY landing apply - a host session's live echo as much as a
    // cloud-head ingest - and before the blob reads below: a directory
    // request dispatched earlier must not sweep a row this apply installs.
    cloudIngestSeq += 1;
    cloudIngestSeqByDraft.set(document.draftId, cloudIngestSeq);
  }
  if (rejectRetiredLandingDocument(document)) return;
  if (composerSubmittedDraftDeleteIsPending(document.draftId)) {
    await retrySubmittedDraftDelete(document.draftId);
    return;
  }
  const client = sessionClients.get(document.ownerHostId);
  const hashes = blobHashesOfDocument(document);
  if (client !== undefined && hashes.length > 0) {
    const images = await readDraftBlobsIntoLocalStore(
      document.ownerHostId,
      client,
      hashes,
    );
    // Admission first: a hash confirmed on a host that no longer owns the
    // row would let eviction drop the only local bytes.
    if (admit !== null && !admit()) return;
    rememberLandingBlobsOnHost(document.draftId, [...images.keys()]);
    if (document.kind === "stash-entry") {
      await ingestStashDocument(document, images);
      return;
    }
  }
  if (admit !== null && !admit()) return;
  if (document.kind === "stash-entry") {
    await ingestStashDocument(document, new Map());
    return;
  }
  if (document.kind === "interview") {
    applyInterviewHostDocument(document);
    return;
  }
  if (document.kind === "landing") {
    if (rejectRetiredLandingDocument(document)) return;
    applyLandingHostDocument(document, document.portable.content);
    return;
  }
  if (document.kind === "chat-composer") {
    applyComposerHostDocument(document);
    return;
  }
  applyNewChatHostDocument(document);
}

function collectAllDirtyWrites(hostId: string): readonly DraftDirtyWrite[] {
  const out: DraftDirtyWrite[] = [];
  for (const { draft } of collectLandingDirtyWrites(hostId)) {
    // An edit withheld by `routeLocalEdit` (placement moved elsewhere) is
    // not swept onto the old host either; the placement host's claim
    // re-routes the row. A cleared placement keeps the hold: the old
    // session can outlive the landing mount (a tab mirror's reference)
    // and its reconnect sweep must not deliver the edit there.
    if (heldLandingEdits.has(draft.id) && hostId !== landingAdoptionHostId) {
      continue;
    }
    out.push({
      generation: draft.generation,
      write: composerDraftWrite({
        draftId: draft.id,
        kind: "landing",
        target: landingTarget(),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        content: draft.content,
        selection: draft.selection,
        runSettings: draft.settings,
        composerMode: draft.composerMode,
        workspace: draft.workspace,
        closed: draft.closed,
      }),
    });
  }
  for (const { chatId, draft } of collectComposerDirtyWrites()) {
    if (composerHostByChatId.get(chatId) !== hostId) continue;
    if (draft.draftId === null) continue;
    if (draft.targetEpicId === null) {
      warnUnboundComposerTarget(chatId, draft.draftId);
      continue;
    }
    out.push({
      generation: draft.generation,
      write: composerDraftWrite({
        draftId: draft.draftId,
        kind: "chat-composer",
        target: requiredChatTarget({
          epicId: draft.targetEpicId,
          chatId,
          blockId: null,
        }),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        content: draft.content,
        selection: draft.selection,
        runSettings: null,
        composerMode: "chat",
        workspace: null,
        closed: false,
      }),
    });
  }
  for (const { chatId, blockId, draft } of collectInterviewDirtyWrites()) {
    if (
      interviewHostByKey.get(interviewDraftBindingKey(chatId, blockId)) !==
      hostId
    ) {
      continue;
    }
    if (draft.targetEpicId === null) {
      warnUnboundInterviewTarget(chatId, blockId, draft.draftId);
      continue;
    }
    out.push({
      generation: draft.generation,
      write: interviewDraftWrite({
        draftId: draft.draftId,
        target: requiredChatTarget({
          epicId: draft.targetEpicId,
          chatId,
          blockId,
        }),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        draft,
      }),
    });
  }
  for (const { epicId, patch } of collectNewChatDirtyWrites()) {
    if (newChatHostByEpicId.get(epicId) !== hostId) continue;
    if (patch.draftId === null) continue;
    out.push({
      generation: patch.generation,
      write: composerDraftWrite({
        draftId: patch.draftId,
        kind: "new-chat",
        target: newChatTarget(epicId),
        revision: patch.hostRevision,
        lastTouchedAt: patch.lastTouchedAt,
        content: patch.content ?? EMPTY_LANDING_DRAFT_CONTENT,
        selection: patch.selection,
        runSettings: patch.settings,
        composerMode: patch.composerMode,
        workspace: patch.workspace,
        closed: false,
      }),
    });
  }
  return out;
}

const warnedUnboundComposer = new Set<string>();
const warnedUnboundInterview = new Set<string>();

function warnUnboundComposerTarget(chatId: string, draftId: string): void {
  if (!import.meta.env.DEV) return;
  if (warnedUnboundComposer.has(chatId)) return;
  warnedUnboundComposer.add(chatId);
  appLogger.warn(
    "[draft-mirror] withholding chat-composer upsert until targetEpicId is bound",
    { chatId, draftId },
  );
}

function warnUnboundInterviewTarget(
  chatId: string,
  blockId: string,
  draftId: string,
): void {
  if (!import.meta.env.DEV) return;
  const key = interviewDraftBindingKey(chatId, blockId);
  if (warnedUnboundInterview.has(key)) return;
  warnedUnboundInterview.add(key);
  appLogger.warn(
    "[draft-mirror] withholding interview upsert until targetEpicId is bound",
    { chatId, blockId, draftId },
  );
}

function hostIdForDraft(draftId: string): string | null {
  const landingDeleteHostId = pendingLandingDraftDeleteHostId(draftId);
  if (landingDeleteHostId !== null) return landingDeleteHostId;
  const pendingDeleteHostId = pendingSubmittedDraftDeleteHostId(draftId);
  if (pendingDeleteHostId !== null) return pendingDeleteHostId;
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  if (landing !== undefined) {
    return landing.adoption.state === "adopted"
      ? landing.adoption.hostId
      : null;
  }
  const composerChatId = findComposerChatIdByDraftId(draftId);
  if (composerChatId !== null) {
    return composerHostByChatId.get(composerChatId) ?? null;
  }
  const interview = findInterviewByDraftId(draftId);
  if (interview !== null) {
    return (
      interviewHostByKey.get(
        interviewDraftBindingKey(interview.chatId, interview.blockId),
      ) ?? null
    );
  }
  const newChat = findNewChatByDraftId(draftId);
  if (newChat !== null) {
    return newChatHostByEpicId.get(newChat.epicId) ?? null;
  }
  return stashHostById.get(draftId) ?? null;
}

function sessionForDraft(draftId: string): DraftMirrorSession | null {
  const hostId = hostIdForDraft(draftId);
  if (hostId === null) return null;
  return sessions.get(hostId)?.session ?? null;
}

function routeLocalEdit(draftId: string): void {
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  // A replica's edit is not queued anywhere: its adoption still names the
  // previous owner, whose session (if mounted here) must not publish this
  // device's edit onto that owner's row before the claim settles. The row is
  // re-routed when the claim lands (`adoptOwnershipOverLocalEdit`).
  if (landing !== undefined && landing.origin === "replica") return;
  // An own row adopted on a host the landing placement has since left (an
  // auto-follow) is held the same way: its first edit here claims for the
  // placement host, and the old host's session must not publish it first.
  if (
    landing !== undefined &&
    landing.adoption.state === "adopted" &&
    landingAdoptionHostId !== null &&
    landing.adoption.hostId !== landingAdoptionHostId
  ) {
    heldLandingEdits.add(draftId);
    return;
  }
  if (landing !== undefined && landing.adoption.state === "unadopted") {
    if (landingAdoptionHostId === null) return;
    sessions.get(landingAdoptionHostId)?.session.noteDirty(draftId);
    return;
  }
  sessionForDraft(draftId)?.noteDirty(draftId);
}

function routeLocalDelete(draftId: string): void {
  heldLandingEdits.delete(draftId);
  const hostId = hostIdForDraft(draftId);
  if (hostId === null) return;
  const session = sessions.get(hostId)?.session;
  if (session === undefined) return;
  void session.deleteOnHostOutcome(draftId).then((outcome) => {
    settleLandingDeleteOutcome(draftId, hostId, outcome);
  });
}

/**
 * Apply a host's `drafts.delete` answer to a landing retirement receipt -
 * only while the receipt still names `hostId`: a claim that landed since
 * has retargeted the receipt to the new owner (`rearmLandingDraftDelete`),
 * and this older answer says nothing about that host's row.
 */
function settleLandingDeleteOutcome(
  draftId: string,
  hostId: string,
  outcome: DraftDeleteOutcome,
): void {
  if (pendingLandingDraftDeleteHostId(draftId) !== hostId) return;
  if (outcome === "deleted" || outcome === "unsupported") {
    completeLandingDraftDelete(draftId);
    return;
  }
  if (outcome !== "absent") return;
  // `absent` from a host whose ownership was never confirmed (a repair's
  // speculative retirement): the claim did not commit there, nothing is
  // owed anywhere, and the still-owner's original stays.
  if (isLandingDraftRetirementSpeculative(draftId)) {
    completeLandingDraftDelete(draftId);
    return;
  }
  // `absent` from the confirmed owner: never had it, or another device's
  // claim moved it elsewhere while this delete was on its way. The receipt
  // goes back to owner-unresolved so the new owner's next document routes
  // the delete there, instead of a completed receipt hiding a row that
  // still exists. `failed` leaves it pending for retry.
  unresolveLandingDraftRetirementOwner(draftId);
}

function routeLocalFlush(draftId: string): void {
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  if (landing !== undefined && landing.adoption.state === "unadopted") {
    if (landingAdoptionHostId === null) return;
    const session = sessions.get(landingAdoptionHostId)?.session;
    if (session === undefined) return;
    void session.flush([draftId]);
    return;
  }
  void flushDraftMirrorSessions([draftId]);
}

setDraftLocalEditListener(routeLocalEdit);
setDraftLocalDeleteListener(routeLocalDelete);
setDraftLocalFlushListener(routeLocalFlush);
setLandingPlacementHostReader(() => landingAdoptionHostId);

export interface AcquireDraftMirrorArgs {
  readonly hostId: string;
  readonly client: HostRequester<HostRpcRegistry>;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly timing: Partial<DraftMirrorTiming> | undefined;
}

export function acquireDraftMirrorSession(
  args: AcquireDraftMirrorArgs,
): DraftMirrorSession {
  const existing = sessions.get(args.hostId);
  if (existing !== undefined) {
    existing.refCount += 1;
    return existing.session;
  }
  // New session = new host connection. Re-probe blob methods so a
  // host that upgraded while this renderer stayed up is not stuck
  // blob-less until restart.
  forgetBlobUnsupportedHost(args.hostId);
  const session = new DraftMirrorSession({
    hostId: args.hostId,
    rpc: {
      list: async () => {
        const listed = await args.client.request("drafts.list", {});
        setCloudScopeId(args.hostId, listed.scopeId ?? null);
        return listed;
      },
      upsert: (draft) => args.client.request("drafts.upsert", { draft }),
      delete: (draftId) => args.client.request("drafts.delete", { draftId }),
    },
    streamClient: args.streamClient,
    sink,
    timing: args.timing,
    now: undefined,
  });
  sessions.set(args.hostId, { session, refCount: 1 });
  sessionClients.set(args.hostId, args.client);
  session.start();
  return session;
}

export function releaseDraftMirrorSession(hostId: string): void {
  const existing = sessions.get(hostId);
  if (existing === undefined) return;
  existing.refCount -= 1;
  if (existing.refCount > 0) return;
  existing.session.close();
  sessions.delete(hostId);
  sessionClients.delete(hostId);
  cloudScopeIdByHost.delete(hostId);
  notifyCloudScopeListeners();
}

export async function flushDraftMirrorSessions(
  draftIds: ReadonlyArray<string> | null,
): Promise<void> {
  if (draftIds === null) {
    await Promise.all(
      [...sessions.values()].map((entry) => entry.session.flush(null)),
    );
    return;
  }
  const idsByHost = new Map<string, string[]>();
  for (const draftId of draftIds) {
    const hostId = hostIdForDraft(draftId);
    if (hostId === null) continue;
    const bucket = idsByHost.get(hostId);
    if (bucket === undefined) {
      idsByHost.set(hostId, [draftId]);
      continue;
    }
    bucket.push(draftId);
  }
  await Promise.all(
    [...idsByHost.entries()].map(([hostId, ids]) => {
      const session = sessions.get(hostId)?.session;
      return session === undefined ? Promise.resolve() : session.flush(ids);
    }),
  );
}

/**
 * Decision #9: adopt on the first debounced sync for the landing
 * placement host, not on mount. `wanted === null` means every dirty
 * unadopted landing draft (bootstrap / flush-all).
 */
export async function adoptUnadoptedLandingDraftsForHost(
  hostId: string,
  wanted: ReadonlySet<string> | null,
): Promise<void> {
  if (landingAdoptionHostId !== hostId) return;
  const client = sessionClients.get(hostId);
  // `upsertDirty` awaits this before it collects a single write, so awaiting
  // each draft's blobs in turn put N serialized round trips in front of the
  // first upsert of every bootstrap flush. The uploads are independent.
  const uploads: Promise<void>[] = [];
  for (const draft of collectUnadoptedLandingDrafts()) {
    if (wanted !== null && !wanted.has(draft.id)) continue;
    adoptLandingDraft(draft.id, hostId);
    if (client === undefined) continue;
    const hashes = blobHashesFromContent(draft.content);
    uploads.push(
      putDraftBlobs(hostId, client, hashes).then((confirmed) => {
        rememberLandingBlobsOnHost(draft.id, confirmed);
      }),
    );
  }
  await Promise.all(uploads);
}

export function resetDraftMirrorCoordinatorForTests(): void {
  for (const entry of sessions.values()) {
    entry.session.close();
  }
  sessions.clear();
  sessionClients.clear();
  knownLandingDraftIds.clear();
  cloudScopeIdByHost.clear();
  composerHostByChatId.clear();
  interviewHostByKey.clear();
  interviewBindingRefs.clear();
  newChatHostByEpicId.clear();
  landingAdoptionHostId = null;
  heldLandingEdits.clear();
  cloudIngestSeq = 0;
  cloudIngestSeqByDraft.clear();
  stashHostById.clear();
  stashSeenOnHost.clear();
  warnedUnboundComposer.clear();
  warnedUnboundInterview.clear();
  resetDraftBlobTransportForTests();
  notifyCloudScopeListeners();
  // Re-bind production listeners. Tests that install their own must not
  // leave `routeLocalDelete` unbound for later files in the same worker.
  setDraftLocalEditListener(routeLocalEdit);
  setDraftLocalDeleteListener(routeLocalDelete);
  setDraftLocalFlushListener(routeLocalFlush);
  setLandingPlacementHostReader(() => landingAdoptionHostId);
}

export function draftMirrorSessionCountForTests(): number {
  return sessions.size;
}

export async function submitComposerDraft(chatId: string): Promise<void> {
  const before = readComposerDraftSnapshot(chatId);
  const hostId =
    before.draftId === null ? null : hostIdForDraft(before.draftId);
  const store = useComposerDraftStore.getState();
  store.clearDraft(chatId);
  if (before.draftId === null || hostId === null) return;
  // Then retire the id. `clearDraft` keeps it, so an edit made during the
  // flush/delete round-trip below would be published under the id this
  // function is about to tombstone, and the tombstone would mark that
  // content synced. The next edit mints a fresh id and a fresh host row.
  store.fenceAndDetachSubmittedDraft(chatId, before.draftId, hostId);
  await retrySubmittedDraftDelete(before.draftId);
}

async function retrySubmittedDraftDelete(draftId: string): Promise<void> {
  const hostId = pendingSubmittedDraftDeleteHostId(draftId);
  if (hostId === null) return;
  const session = sessions.get(hostId)?.session;
  if (session === undefined) return;
  if (await session.deleteOnHost(draftId)) {
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
  }
}

export function collectDraftMirrorDirtyWrites(
  hostId: string,
): readonly DraftDirtyWrite[] {
  return collectAllDirtyWrites(hostId);
}

export async function applyIncomingDraftDocument(
  document: DraftDocument,
  admit: (() => boolean) | null,
): Promise<void> {
  await applyHostDocument(document, admit);
}

export async function ingestCloudDraftSummary(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): Promise<void> {
  if (input.summary.ownerHostId === input.hostId) return;
  // A host-bound surface is never a replica here. `applyComposerHostDocument`
  // keys on `target.chatId`, so ingesting another host's chat-composer draft
  // overwrites the row for a chat that lives on THAT host - flipping the
  // owning host's own live draft to `origin: "replica"`, which is what
  // `draftRequiresClaim` reads to put the composer behind a read-only banner
  // naming the tab's own host. Every tile mount re-ran this, which is why the
  // banner came back on every tab switch.
  if (draftKindIsHostBound(input.document.kind)) return;
  // The fence is reserved by `applyHostDocument` at its (synchronous) start,
  // before the blob reads: an older directory request settling in that
  // window already sees this row as newer than its snapshot.
  // Re-asked right before the store mutation, after the head's blob reads: a
  // claim that landed meanwhile made THIS host the owner, and a replica head
  // from the previous owner must not stamp the row back onto it. The fence
  // is scoped to the ingesting host: an own row of another host (the
  // placement auto-followed here, that host's session absent) is exactly
  // what this directory legitimately supplies a newer head for.
  await applyHostDocument(input.document, () => {
    const row = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === input.document.draftId);
    return (
      row === undefined ||
      row.origin !== "own" ||
      row.ownerHostId !== input.hostId
    );
  });
}

/**
 * Delete a landing draft through `hostId` from a surface that holds that
 * host's client but need not have a mirror session mounted: History runs on
 * the app-wide host, and only the landing placement and mounted tabs
 * acquire sessions, so with the composer pinned elsewhere the routed
 * delete (`notifyDraftLocalDelete` -> `routeLocalDelete`) has no session to
 * reach. A mounted session is preferred (it serializes the tombstone
 * behind in-flight upserts); otherwise the tombstone goes out on the
 * client directly. The receipt stays pending until the host answers, so a
 * failure is retried by whichever session for that host mounts later.
 */
export function deleteLandingDraftThroughHost(
  draftId: string,
  hostId: string,
  client: HostRequester<HostRpcRegistry> | null,
): void {
  deleteLandingDraftOnHost(draftId, hostId);
  if (sessions.has(hostId) || client === null) return;
  if (pendingLandingDraftDeleteHostId(draftId) !== hostId) return;
  void client
    .request("drafts.delete", { draftId })
    .then((response) => {
      settleLandingDeleteOutcome(
        draftId,
        hostId,
        response.deleted ? "deleted" : "absent",
      );
    })
    .catch((error: unknown) => {
      if (isDraftsCapabilityMissing(error)) {
        settleLandingDeleteOutcome(draftId, hostId, "unsupported");
        return;
      }
      appLogger.warn("[draft-mirror] direct drafts.delete failed", {
        error: describeLogError(error),
      });
    });
}

/** The current ingest sequence; a directory captures it at dispatch. */
export function cloudDraftIngestSeq(): number {
  return cloudIngestSeq;
}

/**
 * Reserve the absence-sweep fence for a draft whose cloud head is about
 * to be READ: the read (head plus parts) can take a while, and an older
 * directory snapshot settling meanwhile must not sweep the existing mirror
 * the apply is about to refresh. `applyHostDocument` reserves again at the
 * apply; a read with a terminal outcome simply leaves this reservation,
 * which protects the row until a later snapshot.
 */
export function reserveCloudDraftIngestFence(draftId: string): void {
  cloudIngestSeq += 1;
  cloudIngestSeqByDraft.set(draftId, cloudIngestSeq);
}

/**
 * Drop local mirrors of cloud rows a settled directory no longer lists.
 * `fenceSeq` is the ingest sequence at that directory's fetch start: a row
 * ingested since is kept. A replica qualifies once clean. An OWN row
 * adopted on another host qualifies only when it was published (an
 * unpublished own row is never listed) and that host has no mirror
 * session here (a mounted session delivers its own tombstones, and its
 * unsynced writes may not have reached the directory yet).
 */
export function sweepAbsentCloudDraftMirrors(
  hostId: string,
  listed: ReadonlyMap<string, ReadonlySet<string>>,
  fenceSeq: number,
): readonly string[] {
  return dropForeignLandingMirrorsAbsent(hostId, listed, (draft) => {
    if ((cloudIngestSeqByDraft.get(draft.id) ?? 0) > fenceSeq) return false;
    if (draft.origin === "replica") return true;
    // A row with no recorded publication state is treated as unpublished.
    return (
      draft.publication !== null &&
      draft.publication.status !== "unpublished" &&
      draft.adoption.state === "adopted" &&
      !sessions.has(draft.adoption.hostId)
    );
  });
}

registerExtraImageRootSource({
  hashes: () => {
    const hashes: string[] = [];
    for (const draft of Object.values(
      useComposerDraftStore.getState().drafts,
    )) {
      if (draft === undefined) continue;
      hashes.push(...blobHashesFromContent(draft.content));
    }
    for (const patch of Object.values(
      useNewConversationModalStore.getState().draftPatchesByEpicId,
    )) {
      if (patch === undefined || patch.content === null) continue;
      hashes.push(...blobHashesFromContent(patch.content));
    }
    for (const row of usePromptStashStore.getState().rows) {
      if (row.kind !== "entry") continue;
      hashes.push(...row.entry.blobHashes);
    }
    return hashes;
  },
});

export type { DraftWrite };
