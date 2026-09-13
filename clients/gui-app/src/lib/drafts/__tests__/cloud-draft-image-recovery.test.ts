import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordCloudDraftImageSources,
  readCloudDraftImageBytes,
  recoverCloudDraftImages,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_1",
  chatId: "draft-1",
  ownerUserId: "user-1",
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

/**
 * What a fake answers, before it is narrowed to the registry's per-method
 * response type.
 *
 * `HostRequester["request"]` is generic over the method, so a handler written
 * to answer ONE method cannot satisfy it directly - the assertion has to happen
 * once, at the boundary where the fake becomes a client. Same shape the sibling
 * draft-coordinator tests use.
 */
type FakeHandler = (method: string, params: unknown) => unknown;

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** A `DraftBlobClient` whose `request` calls are recorded for assertions. */
function recordingClient(handle: FakeHandler): {
  readonly client: DraftBlobClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const request = ((method: string, params: unknown) => {
    calls.push({ method, params });
    return handle(method, params);
  }) as FakeRequest;
  return { client: { request }, calls };
}

/** A client that answers every `epic.readCloudChatPayload` the same way. */
function okClient(
  bytesBase64: string,
  byteLength: number,
): {
  readonly client: DraftBlobClient;
  readonly calls: RecordedCall[];
} {
  return recordingClient((_method, _params) =>
    Promise.resolve({
      outcome: { status: "ok" as const, bytesBase64, byteLength },
    }),
  );
}

async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes));
}

// `landing-image-store` keeps an in-memory session cache keyed by hash that
// `installFreshIndexedDb()` does NOT clear between tests (it only replaces
// the IndexedDB backend) - so any two tests using the same byte content would
// silently share a cache hit. Every call below mints content that has never
// been used before, in this file or any other, so no test's assertion can be
// satisfied by a stale write.
let uniqueByteSeed = 0;

function uniqueBytes(length: number): Uint8Array<ArrayBuffer> {
  uniqueByteSeed += 1;
  const seed = uniqueByteSeed;
  return new Uint8Array(
    Array.from({ length }, (_unused, index) => (seed * 31 + index * 7) % 256),
  );
}

function bytesA(): Uint8Array<ArrayBuffer> {
  return uniqueBytes(5);
}

function bytesB(): Uint8Array<ArrayBuffer> {
  return uniqueBytes(4);
}

beforeEach(() => {
  installFreshIndexedDb();
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  resetCloudDraftImageRecoveryForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-draft-image-recovery", () => {
  it("fetches, verifies and stores bytes for a recorded hash", async () => {
    const bytes = bytesA();
    const hash = await sha256HexOf(bytes);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });
    const result = await readCloudDraftImageBytes(hash);

    expect(result).toEqual(bytes);
    expect(await getImageBytes(hash)).toEqual(bytes);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("epic.readCloudChatPayload");
    expect(calls[0]?.params).toEqual({
      ...IDENTITY,
      ref: { kind: "image-attachment", sha256: hash },
    });
  });

  it("refuses a digest mismatch: stores nothing and answers null, with a matching-bytes positive control", async () => {
    const requested = bytesA();
    const wrongHash = await sha256HexOf(requested);
    const wrongBytes = bytesB(); // does NOT hash to `wrongHash`
    const { client: mismatchClient } = okClient(
      toBase64(wrongBytes),
      wrongBytes.byteLength,
    );
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client: mismatchClient,
      hashes: [wrongHash],
    });

    const mismatchResult = await readCloudDraftImageBytes(wrongHash);
    expect(mismatchResult).toBeNull();
    expect(await getImageBytes(wrongHash)).toBeUndefined();

    // Positive control: the identical setup, but the served bytes actually
    // hash to the requested digest, stores and returns them. Proves the test
    // above would go red if verification were removed.
    const goodBytes = bytesB();
    const goodHash = await sha256HexOf(goodBytes);
    const { client: matchClient } = okClient(
      toBase64(goodBytes),
      goodBytes.byteLength,
    );
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client: matchClient,
      hashes: [goodHash],
    });
    const goodResult = await readCloudDraftImageBytes(goodHash);
    expect(goodResult).toEqual(goodBytes);
    expect(await getImageBytes(goodHash)).toEqual(goodBytes);
  });

  it("leaves a hash-only node when the cloud blob is unavailable, per-image not per-pass", async () => {
    const missingBytes = bytesA();
    const missingHash = await sha256HexOf(missingBytes);
    const availableBytes = bytesB();
    const availableHash = await sha256HexOf(availableBytes);

    const { client } = recordingClient((_method, params) => {
      const { ref } = params as { ref: { sha256: string } };
      if (ref.sha256 === missingHash) {
        return Promise.resolve({ outcome: { status: "unavailable" as const } });
      }
      return Promise.resolve({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(availableBytes),
          byteLength: availableBytes.byteLength,
        },
      });
    });

    await recoverCloudDraftImages({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [missingHash, availableHash],
    });

    expect(await getImageBytes(missingHash)).toBeUndefined();
    // Sibling hash in the same eager pass: proves the pass ran to completion
    // rather than dying on the first miss.
    expect(await getImageBytes(availableHash)).toEqual(availableBytes);
  });

  it("never throws: a transport rejection answers null through both the lazy leg and the eager pass", async () => {
    const bytes = bytesA();
    const hash = await sha256HexOf(bytes);
    const { client } = recordingClient((_method, _params) =>
      Promise.reject(new Error("transport died")),
    );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });
    await expect(readCloudDraftImageBytes(hash)).resolves.toBeNull();

    resetCloudDraftImageRecoveryForTests();
    await expect(
      recoverCloudDraftImages({
        identity: IDENTITY,
        hostId: "host-a",
        client,
        hashes: [hash],
      }),
    ).resolves.toBeUndefined();
  });

  it("issues no request for an unrecorded hash, paired with a recorded hash that does", async () => {
    const unrecordedHash = "f".repeat(64);
    const bytes = bytesA();
    const recordedHash = await sha256HexOf(bytes);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);

    const unrecordedResult = await readCloudDraftImageBytes(unrecordedHash);
    expect(unrecordedResult).toBeNull();
    expect(calls).toHaveLength(0);

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [recordedHash],
    });
    const recordedResult = await readCloudDraftImageBytes(recordedHash);
    expect(recordedResult).toEqual(bytes);
    expect(calls).toHaveLength(1);
  });

  it("memoizes E_HOST_UNSUPPORTED per host, with a positive control on a different host", async () => {
    const bytesOne = bytesA();
    const hashOne = await sha256HexOf(bytesOne);
    const bytesTwo = bytesB();
    const hashTwo = await sha256HexOf(bytesTwo);

    const { client: unsupportedClient, calls: unsupportedCalls } =
      recordingClient((_method, _params) =>
        Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "old host",
            requestId: "r1",
            method: "epic.readCloudChatPayload",
            fatalDetails: null,
          }),
        ),
      );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client: unsupportedClient,
      hashes: [hashOne],
    });
    const first = await readCloudDraftImageBytes(hashOne);
    expect(first).toBeNull();
    expect(unsupportedCalls).toHaveLength(1);

    // A second hash recorded against the SAME host: no second request.
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client: unsupportedClient,
      hashes: [hashTwo],
    });
    const second = await readCloudDraftImageBytes(hashTwo);
    expect(second).toBeNull();
    expect(unsupportedCalls).toHaveLength(1);

    // Positive control: a hash recorded against a DIFFERENT host still issues
    // its request, proving the memo is per-host, not global.
    const { client: otherHostClient, calls: otherHostCalls } = okClient(
      toBase64(bytesTwo),
      bytesTwo.byteLength,
    );
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-c",
      client: otherHostClient,
      hashes: [hashTwo],
    });
    const third = await readCloudDraftImageBytes(hashTwo);
    expect(third).toEqual(bytesTwo);
    expect(otherHostCalls).toHaveLength(1);
  });

  it("single-flights two concurrent reads of the same hash into one request", async () => {
    const bytes = bytesA();
    const hash = await sha256HexOf(bytes);
    let resolveRequest: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const { client, calls } = recordingClient((_method, _params) =>
      gate.then(() => ({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(bytes),
          byteLength: bytes.byteLength,
        },
      })),
    );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });

    const first = readCloudDraftImageBytes(hash);
    const second = readCloudDraftImageBytes(hash);
    expect(calls).toHaveLength(1);
    resolveRequest?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(firstResult).toEqual(bytes);
    expect(secondResult).toEqual(bytes);
  });

  it("gates dispatch on the auth verdict re-read at dispatch time", async () => {
    const bytes = bytesA();
    const hash = await sha256HexOf(bytes);
    const { client, calls } = okClient(toBase64(bytes), bytes.byteLength);
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });

    useAuthStore.setState({ status: "signed-out" });
    const signedOutResult = await readCloudDraftImageBytes(hash);
    expect(signedOutResult).toBeNull();
    expect(calls).toHaveLength(0);

    useAuthStore.setState({ status: "signed-in" });
    const signedInResult = await readCloudDraftImageBytes(hash);
    expect(signedInResult).toEqual(bytes);
    expect(calls).toHaveLength(1);
  });

  it("skips a hash the local partition already holds in the eager pass", async () => {
    const localBytes = bytesA();
    const localHash = await sha256HexOf(localBytes);
    const remoteBytes = bytesB();
    const remoteHash = await sha256HexOf(remoteBytes);

    // Pre-seed the partition for `localHash` via a first, independent
    // recovery (exercises real production code, not a store bypass).
    const { client: seedClient } = okClient(
      toBase64(localBytes),
      localBytes.byteLength,
    );
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-seed",
      client: seedClient,
      hashes: [localHash],
    });
    expect(await readCloudDraftImageBytes(localHash)).toEqual(localBytes);

    const { client, calls } = recordingClient((_method, params) => {
      const { ref } = params as { ref: { sha256: string } };
      return Promise.resolve({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(
            ref.sha256 === remoteHash ? remoteBytes : localBytes,
          ),
          byteLength:
            ref.sha256 === remoteHash
              ? remoteBytes.byteLength
              : localBytes.byteLength,
        },
      });
    });

    await recoverCloudDraftImages({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [localHash, remoteHash],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      ref: { sha256: remoteHash },
    });
    expect(await getImageBytes(remoteHash)).toEqual(remoteBytes);
  });

  it("bounds eager-pass concurrency to 4 in-flight requests while still fetching every hash", async () => {
    const hashes: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      hashes.push(await sha256HexOf(new Uint8Array([index, index + 1])));
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const requested: string[] = [];
    const { client } = recordingClient((_method, params) => {
      const { ref } = params as { ref: { sha256: string } };
      requested.push(ref.sha256);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = hashes.indexOf(ref.sha256);
      const bytes = new Uint8Array([index, index + 1]);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve({
            outcome: {
              status: "ok" as const,
              bytesBase64: toBase64(bytes),
              byteLength: bytes.byteLength,
            },
          });
        }, 5);
      });
    });

    await recoverCloudDraftImages({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes,
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(requested.sort()).toEqual([...hashes].sort());
  });
});
