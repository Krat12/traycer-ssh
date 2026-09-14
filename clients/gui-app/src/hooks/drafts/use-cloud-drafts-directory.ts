import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  cloudDraftIngestSeq,
  draftsCloudScopeId,
  subscribeDraftsCloudScope,
} from "@/lib/drafts/draft-mirror-coordinator";
import { cloudChatListCacheKeyIdentity } from "@/lib/chats/cloud-chat-list-cache";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";

const EMPTY_CLOUD_DRAFTS: ReadonlyArray<CloudChatSummary> = [];

export interface CloudDraftsDirectory {
  /**
   * False for free-tier, old-host, or publication-not-ready. The
   * cloud-chat "absent section, not a broken tab" contract.
   */
  readonly visible: boolean;
  /** The list has been fetched at least once; `chats` is the directory. */
  readonly settled: boolean;
  readonly scopeId: string | null;
  readonly chats: ReadonlyArray<CloudChatSummary>;
  /**
   * The cloud ingest sequence current when the request that produced
   * `chats` started. An absence in `chats` says nothing about a row
   * ingested after that, so the sweep fences on it. Read in effects, not
   * during render.
   */
  readonly snapshotIngestSeq: () => number;
}

function useDraftsCloudScopeId(hostId: string | null): string | null {
  return useSyncExternalStore(
    subscribeDraftsCloudScope,
    () => (hostId === null ? null : draftsCloudScopeId(hostId)),
    () => null,
  );
}

/**
 * Whether the personal-drafts cloud directory may render. Hidden when
 * the connected host cannot list published drafts — never a failure
 * surface.
 */
export function useCloudDraftsDirectory(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): CloudDraftsDirectory {
  const viewerUserId = useCloudChatViewerId();
  const scopeId = useDraftsCloudScopeId(hostId);
  const query = useHostQuery({
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client,
    method: "epic.listCloudChats",
    params: { taskId: scopeId ?? "" },
    options: {
      enabled:
        client !== null &&
        scopeId !== null &&
        scopeId.length > 0 &&
        viewerUserId.length > 0,
      staleTime: 30_000,
      retry: false,
    },
  });
  const visible = useMemo(
    () =>
      cloudDraftsDirectoryIsVisible({
        scopeId,
        error: query.error,
        isPending: query.isPending,
        isSuccess: query.isSuccess,
      }),
    [query.error, query.isPending, query.isSuccess, scopeId],
  );
  const chats = visible
    ? (query.data?.chats ?? EMPTY_CLOUD_DRAFTS)
    : EMPTY_CLOUD_DRAFTS;
  // Effect order matters: the fetch-start capture is declared before the
  // snapshot capture, so a commit where a fetch both starts and (later)
  // settles records the sequence from the START of that fetch.
  const fetchStartSeq = useRef(0);
  const snapshotSeq = useRef(0);
  useEffect(() => {
    if (query.isFetching) fetchStartSeq.current = cloudDraftIngestSeq();
  }, [query.isFetching]);
  useEffect(() => {
    if (query.isSuccess) snapshotSeq.current = fetchStartSeq.current;
  }, [query.dataUpdatedAt, query.isSuccess]);
  const snapshotIngestSeq = useCallback(() => snapshotSeq.current, []);
  return {
    visible,
    settled: visible && query.isSuccess,
    scopeId,
    chats,
    snapshotIngestSeq,
  };
}
