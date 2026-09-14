import { useCallback, useEffect } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  composerDraftIsDirty,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
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
  const { chatId, tabHostId } = args;
  const repairOnEdit = useCallback((): void => {
    // A refusal whose RPC answer was lost while the claim did commit: an
    // echo may already have made this row this host's own. Re-read first.
    const row = useComposerDraftStore.getState().drafts[chatId];
    if (
      row !== undefined &&
      row.origin === "own" &&
      row.ownerHostId === tabHostId
    ) {
      return;
    }
    useComposerDraftStore.getState().detachDraftIdentity(chatId, tabHostId);
  }, [chatId, tabHostId]);
  const control = useDraftAuthorityControl({
    draftId,
    ownerHostId,
    origin,
    tabHostId: args.tabHostId,
    client: args.client,
    repairOnEdit,
  });
  // A dirty unowned row at mount is an edit whose claim never settled here
  // (the chat was switched away from before the refusal, or the app
  // restarted): re-arm it, as the landing composer does, instead of holding
  // the edit out of the mirror until the next keystroke.
  const { unowned, noteEdit } = control;
  useEffect(() => {
    if (!unowned || draftId === null) return;
    if (composerDraftIsDirty(draftId)) noteEdit();
  }, [draftId, noteEdit, unowned]);
  return control;
}
