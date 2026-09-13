import type { ReactNode } from "react";
import type { DraftAuthorityControl } from "@/hooks/drafts/use-draft-authority";
import { DraftClaimNotice } from "@/components/drafts/draft-claim-notice";
import { ChatComposerBannerPortal } from "./chat-composer-banner-portal";

export function ChatComposerDraftClaimNotice(props: {
  readonly authority: DraftAuthorityControl;
}): ReactNode {
  if (props.authority.claimError === null) return null;
  return (
    <ChatComposerBannerPortal>
      <div className="pointer-events-none px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-4">
          <DraftClaimNotice
            message={props.authority.claimError}
            claiming={props.authority.claiming}
            onRetry={props.authority.retry}
          />
        </div>
      </div>
    </ChatComposerBannerPortal>
  );
}
