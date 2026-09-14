import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { DraftWrite } from "@traycer/protocol/host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  getImageBytes,
  putImageBytesAtHash,
} from "@/lib/composer/landing-image-store";
import { bytesToBase64, base64ToBytes } from "@/lib/composer/image-base64";
import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import { readPromptStashRestoreBlobs } from "@/lib/composer/prompt-stash-repository";
import type { PromptStashImageBlob } from "@/lib/composer/prompt-stash-codec";
import { appLogger, describeLogError } from "@/lib/logger";
import { useAuthStore } from "@/stores/auth/auth-store";
import { blobHashesOfWrite } from "./draft-write-codec";
import { isDraftsCapabilityMissing } from "./draft-capability";

const blobUnsupportedHosts = new Set<string>();

/**
 * ## The once-per-host upload memo
 *
 * Every debounced draft write re-sent every image the draft still carries. The
 * bytes are content-addressed and the host already had them, so each repeat was
 * a megabyte of base64 on the wire to be told "yes, still there" - which is most
 * of what made a large draft's editing traffic unbearable even after the row
 * itself got small.
 *
 * Three maps, all keyed by host first, because every one of these facts is
 * about a particular host and nothing generalizes across two of them.
 *
 *  - `confirmedBlobOwners`: digest -> the owner it was confirmed FOR. Keyed by
 *    owner and not merely present/absent, because the host's draft blob store
 *    is owner-partitioned: the same digest confirmed under account A says
 *    nothing about whether account B's partition holds it, and treating it as
 *    confirmed would send a bare hash into a partition that cannot resolve it.
 *
 *    ONE slot per digest, not a set of owners, and the consequence is stated
 *    here so it is not read later as an oversight: confirming under B REPLACES
 *    A's record, so after an account switch A re-uploads once per digest. That
 *    is the fail-safe direction - an extra upload, never a bare hash the host
 *    cannot answer - and it is the shape the ticket specifies. Widen it to a
 *    per-digest owner SET only if switching accounts on one host turns out to
 *    be common enough for the churn to matter.
 *  - `inFlightBlobUploads`: digest -> the upload already running for it, so two
 *    concurrent first writes of the same image issue ONE request. Registered
 *    before the local byte read, not after: the read is itself an await, and
 *    two callers that both got past it before either registered would both
 *    upload.
 *  - `unbridgeableBlobs`: digests this host answered `unsupported-format` for.
 *    Deliberately NOT owner-keyed and NOT cleared on re-bootstrap, unlike the
 *    confirmations - what a host's writer can decode is a property of the host
 *    BUILD, so neither a different account nor a reconnect changes the answer.
 *    Only `forgetBlobUnsupportedHost` clears it, which is the host-upgraded
 *    signal.
 *
 * ## Why an epoch, and why not the session's own generation
 *
 * A confirmation is only worth keeping if the host that gave it is still the
 * host we are talking to. `drafts.putBlob` can be acknowledged after a
 * reconnect has already re-listed against a host that restarted and lost the
 * blob - recording it then would leave the gate confident about bytes nothing
 * holds, and the send would go out bare.
 *
 * So each upload captures the host's epoch when it STARTS and records its
 * confirmation only if that epoch still stands. The wire call still counts as
 * having succeeded - `putDraftBlobs` returns the digest either way, leaving
 * `rememberLandingBlobsOnHost` exactly as it was - it simply is not memoized.
 *
 * `DraftMirrorSession`'s own `bootGeneration` looks like the right counter and
 * is not: it bumps only in `close()`, so the reconnect re-bootstrap - the case
 * that matters here - reuses it. Bumping it there instead would also change
 * when `runBootstrap`'s two early-return guards fire, which is not this
 * ticket's to move.
 */
const confirmedBlobOwners = new Map<string, Map<string, string>>();
const inFlightBlobUploads = new Map<string, Map<string, Promise<boolean>>>();
const unbridgeableBlobs = new Map<string, Set<string>>();
const blobEpochs = new Map<string, number>();

export function resetDraftBlobTransportForTests(): void {
  blobUnsupportedHosts.clear();
  confirmedBlobOwners.clear();
  inFlightBlobUploads.clear();
  unbridgeableBlobs.clear();
  blobEpochs.clear();
}

/**
 * The account a confirmation is recorded under, and the one the send gate asks
 * about. One reader for both so they can never key on different things - a gate
 * asking under a different id than the upload recorded would simply never fire,
 * silently, and every send would re-inline.
 *
 * `null` (signed out, or the context metadata not yet projected) records and
 * confirms nothing rather than falling back to a placeholder id, which would
 * pool two accounts into one bucket.
 */
export function currentDraftBlobOwnerId(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

function blobEpochOf(hostId: string): number {
  return blobEpochs.get(hostId) ?? 0;
}

/**
 * A new mirror bootstrap for this host: the confirmations it gave belong to the
 * conversation that just ended. Called on the re-bootstrap path too, which
 * acquisition alone does not cover - `draft-mirror-session.ts` re-lists on a
 * reconnect without re-acquiring, and that is exactly when a restarted host has
 * silently dropped its blobs.
 *
 * The unbridgeable set survives, per the module doc.
 */
export function forgetConfirmedDraftBlobs(hostId: string): void {
  blobEpochs.set(hostId, blobEpochOf(hostId) + 1);
  confirmedBlobOwners.delete(hostId);
  inFlightBlobUploads.delete(hostId);
}

/** Whether this host is known to hold `sha256` for `ownerUserId`. */
export function isDraftBlobConfirmed(
  hostId: string,
  sha256: string,
  ownerUserId: string | null,
): boolean {
  if (ownerUserId === null) return false;
  return confirmedBlobOwners.get(hostId)?.get(sha256) === ownerUserId;
}

/**
 * The subset of `hashes` this host holds for this owner - the send gate's
 * question. Answered as a set rather than a per-hash predicate so the caller
 * builds one union and the "every node is covered" test is a single pass.
 */
export function confirmedDraftBlobHashes(
  hostId: string,
  ownerUserId: string | null,
  hashes: ReadonlyArray<string>,
): ReadonlySet<string> {
  const held = new Set<string>();
  if (ownerUserId === null) return held;
  const perHost = confirmedBlobOwners.get(hostId);
  if (perHost === undefined) return held;
  for (const sha256 of hashes) {
    if (perHost.get(sha256) === ownerUserId) held.add(sha256);
  }
  return held;
}

/**
 * Drop these digests' confirmations for this host - the host says it does not
 * have them after all (`not-on-host`). The next write re-uploads.
 */
export function invalidateDraftBlobConfirmations(
  hostId: string,
  hashes: ReadonlyArray<string>,
): void {
  const perHost = confirmedBlobOwners.get(hostId);
  if (perHost === undefined) return;
  for (const sha256 of hashes) perHost.delete(sha256);
  if (perHost.size === 0) confirmedBlobOwners.delete(hostId);
}

/**
 * This host's writer refuses this digest's format. The node re-inlines from now
 * on, with no further round trip to be told the same thing.
 */
export function markDraftBlobUnbridgeable(
  hostId: string,
  sha256: string,
): void {
  const perHost = unbridgeableBlobs.get(hostId);
  if (perHost === undefined) {
    unbridgeableBlobs.set(hostId, new Set([sha256]));
    return;
  }
  perHost.add(sha256);
}

export function isDraftBlobUnbridgeable(
  hostId: string,
  sha256: string,
): boolean {
  return unbridgeableBlobs.get(hostId)?.has(sha256) === true;
}

/**
 * Drop the "this host withholds blob methods" cache so the next put/read
 * re-probes. Same shape as T6's scope-cache invalidate: a reconnecting
 * session (host upgraded mid-lifetime) is the signal, not a timer.
 */
export function forgetBlobUnsupportedHost(hostId: string): void {
  blobUnsupportedHosts.delete(hostId);
  // A host that may have upgraded is a host whose every cached verdict is
  // suspect, including which formats it refuses - that is the one signal that
  // can change the unbridgeable answer.
  unbridgeableBlobs.delete(hostId);
  forgetConfirmedDraftBlobs(hostId);
}

export function hostWithholdsDraftBlobs(hostId: string): boolean {
  return blobUnsupportedHosts.has(hostId);
}

function markBlobUnsupported(hostId: string): void {
  blobUnsupportedHosts.add(hostId);
}

function isBlobUnsupported(error: unknown): boolean {
  return (
    isDraftsCapabilityMissing(error) ||
    (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED")
  );
}

async function localBytesForHash(
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const fromLanding = await getImageBytes(hash);
  if (fromLanding !== undefined) return fromLanding;
  const stash = await readPromptStashRestoreBlobs([hash]);
  if (stash.status !== "ok") return null;
  return stash.blobs.get(hash)?.bytes ?? null;
}

/**
 * Upload every `blobHashes` entry the local partition (or stash repo)
 * still holds. Missing local bytes and digest-mismatch skip that hash
 * (fail closed per-image). A host that withholds the methods is treated
 * as an old host: hash-only content, never an error surface.
 */
export type DraftBlobClient = {
  readonly request: HostRequester<HostRpcRegistry>["request"];
};

export async function putDraftBlobsForWrite(
  hostId: string,
  client: DraftBlobClient,
  write: DraftWrite,
  ownerUserId: string | null,
): Promise<ReadonlyArray<string>> {
  return putDraftBlobs(hostId, client, blobHashesOfWrite(write), ownerUserId);
}

export async function putDraftBlobs(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
  ownerUserId: string | null,
): Promise<ReadonlyArray<string>> {
  if (hashes.length === 0) return [];
  if (blobUnsupportedHosts.has(hostId)) return [];
  const confirmed: string[] = [];
  for (const sha256 of hashes) {
    // The memo hit, and the whole point of the ticket: no local read, no
    // base64, no request.
    if (isDraftBlobConfirmed(hostId, sha256, ownerUserId)) {
      confirmed.push(sha256);
      continue;
    }
    if (await joinOrStartBlobUpload(hostId, client, sha256, ownerUserId)) {
      confirmed.push(sha256);
    }
    // Checked after each digest rather than only on the throw: a joined upload
    // can be the one that discovers the host withholds the methods, and its
    // joiner sees that only through this flag.
    if (blobUnsupportedHosts.has(hostId)) return confirmed;
  }
  return confirmed;
}

/**
 * One upload per (host, digest) at a time. A second caller for a digest already
 * going up awaits that same promise instead of starting its own.
 *
 * The registration is synchronous with the decision to start - before
 * `uploadOneDraftBlob`'s first await - which is the only ordering that actually
 * dedupes. Registering after the local byte read would let two callers both
 * finish that read, both find the map empty, and both upload.
 */
function joinOrStartBlobUpload(
  hostId: string,
  client: DraftBlobClient,
  sha256: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const joined = inFlightBlobUploads.get(hostId)?.get(sha256);
  if (joined !== undefined) return joined;
  // Never rejects - every failure is contained into `false` - so the cleanup
  // below and the joiners above need no rejection handling of their own.
  const flight = uploadOneDraftBlob(hostId, client, sha256, ownerUserId);
  const perHost = inFlightBlobUploads.get(hostId);
  if (perHost === undefined) {
    inFlightBlobUploads.set(hostId, new Map([[sha256, flight]]));
  } else {
    perHost.set(sha256, flight);
  }
  void flight.finally(() => {
    const live = inFlightBlobUploads.get(hostId);
    // Identity-checked: `forgetConfirmedDraftBlobs` may have dropped this
    // host's map and a NEWER upload of the same digest may already own the
    // slot. Deleting by key alone would evict that one and un-dedupe it.
    if (live?.get(sha256) !== flight) return;
    live.delete(sha256);
    if (live.size === 0) inFlightBlobUploads.delete(hostId);
  });
  return flight;
}

/** Resolves `true` when the host acknowledged holding the digest. Never rejects. */
async function uploadOneDraftBlob(
  hostId: string,
  client: DraftBlobClient,
  sha256: string,
  ownerUserId: string | null,
): Promise<boolean> {
  // Captured at the START, per the module doc: what matters is whether the
  // conversation this upload belongs to is still the live one by the time it
  // is answered.
  const epoch = blobEpochOf(hostId);
  try {
    // Inside the try, not before it. The local read is IndexedDB (or the stash
    // repo) and can reject; outside the containment that rejection escaped as
    // the flight's own, and the cleanup `.finally` chained onto it - which
    // nothing awaits - became a SECOND, detached unhandled rejection even when
    // the caller handled the first. The "never rejects" claim above has to be
    // true across the whole operation for that discarded promise to be safe.
    const bytes = await localBytesForHash(sha256);
    if (bytes === null) return false;
    const response = await client.request("drafts.putBlob", {
      sha256,
      bytesBase64: bytesToBase64(bytes),
    });
    if (!response.ok) {
      appLogger.warn("[draft-blobs] putBlob digest-mismatch", { sha256 });
      return false;
    }
    if (blobEpochOf(hostId) !== epoch) {
      // The wire call succeeded, so the caller still counts it - what is
      // dropped is the MEMO, because this acknowledgement describes a mirror
      // conversation that has since been replaced.
      appLogger.warn("[draft-blobs] putBlob acknowledged after re-bootstrap", {
        sha256,
      });
      return true;
    }
    if (ownerUserId !== null) recordConfirmedBlob(hostId, sha256, ownerUserId);
    return true;
  } catch (error: unknown) {
    if (isBlobUnsupported(error)) {
      markBlobUnsupported(hostId);
      return false;
    }
    appLogger.warn("[draft-blobs] putBlob failed", {
      sha256,
      error: describeLogError(error),
    });
    return false;
  }
}

function recordConfirmedBlob(
  hostId: string,
  sha256: string,
  ownerUserId: string,
): void {
  const perHost = confirmedBlobOwners.get(hostId);
  if (perHost === undefined) {
    confirmedBlobOwners.set(hostId, new Map([[sha256, ownerUserId]]));
    return;
  }
  perHost.set(sha256, ownerUserId);
}

/**
 * Fetch missing hashes into the window-partitioned landing-image-store.
 * Already-local hashes are left alone. `missing` / corrupt collapse to
 * skip (images render unavailable).
 */
export function readDraftBlobsIntoLocalStore(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  return readDraftBlobs(hostId, client, hashes, putImageBytesAtHash);
}

/** Read without storing so recovery can admit the complete byte batch first.
 * The recovery writer must validate digests before installing these bytes.
 */
export function readDraftBlobsForRecovery(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  return readDraftBlobs(hostId, client, hashes, () => Promise.resolve(true));
}

async function readDraftBlobs(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
  store: (hash: string, bytes: ImageBytes) => Promise<boolean>,
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  const images = new Map<string, PromptStashImageBlob>();
  if (hashes.length === 0) return images;
  if (blobUnsupportedHosts.has(hostId)) return images;
  for (const sha256 of hashes) {
    // Contained, and the containment is the point: an unavailable or failing
    // IndexedDB makes this reject, and OUTSIDE a catch that rejection escaped
    // the whole read - taking the `drafts.readBlob` request below with it, so
    // a host that had the bytes was never asked. A local-store fault is "not
    // here", which is exactly the case the host leg exists for.
    const existing = await getImageBytes(sha256).catch((error: unknown) => {
      appLogger.warn("[draft-blobs] local image read failed", {
        sha256,
        error: describeLogError(error),
      });
      return undefined;
    });
    if (existing !== undefined) {
      const mimeType = sniffImageMimeType(existing) ?? "image/png";
      images.set(sha256, { bytes: existing, mimeType });
      continue;
    }
    try {
      const response = await client.request("drafts.readBlob", { sha256 });
      if (!response.ok) continue;
      const bytes = base64ToBytes(response.bytesBase64);
      if (bytes === null) continue;
      const stored = await store(sha256, bytes);
      if (!stored) continue;
      const mimeType = sniffImageMimeType(bytes) ?? "image/png";
      images.set(sha256, { bytes, mimeType });
    } catch (error: unknown) {
      if (isBlobUnsupported(error)) {
        markBlobUnsupported(hostId);
        return images;
      }
      appLogger.warn("[draft-blobs] readBlob failed", {
        sha256,
        error: describeLogError(error),
      });
    }
  }
  return images;
}
