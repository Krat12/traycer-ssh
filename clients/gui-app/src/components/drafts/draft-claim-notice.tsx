import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shown only after a silent takeover was refused. The draft stays editable;
 * this names why the edits are not yet syncing from here and offers the
 * retry. Never names a host: the user has no device concept to reason about.
 */
export function DraftClaimNotice(props: {
  readonly message: string | null;
  readonly claiming: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  if (props.message === null) return null;
  return (
    <div
      data-testid="draft-claim-notice"
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-ui-sm text-muted-foreground"
    >
      <p>{props.message}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.claiming}
        onClick={props.onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
