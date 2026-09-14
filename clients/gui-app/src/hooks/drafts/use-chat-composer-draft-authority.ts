import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  useDraftAuthorityControl,
  type DraftAuthorityControl,
} from "./use-draft-authority";

export function useChatComposerDraftAuthority(args: {
  readonly chatId: string;
  readonly tabHostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
}): DraftAuthorityControl {
  const draftId = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.draftId ?? null,
  );
  const ownerHostId = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.ownerHostId ?? null,
  );
  const origin = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.origin ?? null,
  );
  // A chat draft names a surface that exists only on the chat's host, so it
  // is never a replica of another host's row (the ingest declines those);
  // an unowned chat draft is this host's own row demoted after a claim
  // elsewhere. The repair keeps the content and mints a fresh identity.
  const { chatId } = args;
  const repairOnEdit = useCallback((): void => {
    useComposerDraftStore.getState().detachDraftIdentity(chatId);
  }, [chatId]);
  return useDraftAuthorityControl({
    draftId,
    ownerHostId,
    origin,
    tabHostId: args.tabHostId,
    client: args.client,
    repairOnEdit,
  });
}
