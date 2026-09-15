import { useId, useState } from "react";
import type { SshHostConnection } from "@traycer-clients/shared/platform/ssh-host";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useRunnerChangeSshHost,
  useRunnerSshHosts,
} from "@/hooks/runner/use-ssh-hosts";
import { useRunnerHost } from "@/providers/use-runner-host";

const CONNECTION_LABEL = {
  connecting: "Connecting",
  connected: "Connected via SSH",
  reconnecting: "Reconnecting",
  error: "Connection failed",
} as const;

function SshChangeSpinner(props: { readonly active: boolean }) {
  return props.active ? (
    <AgentSpinningDots
      variant="orbit"
      className="text-current"
      testId={undefined}
    />
  ) : null;
}

export function SshHostConnectionCard(props: {
  readonly hostId: string;
  readonly hostLabel: string;
}) {
  const manager = useRunnerHost().sshHosts;
  const connections = useRunnerSshHosts();
  if (manager === undefined) return null;
  if (connections.isPending) {
    return (
      <p className="text-ui-sm text-muted-foreground">Loading SSH settings…</p>
    );
  }
  if (connections.isError) {
    return (
      <p role="alert" className="text-ui-sm text-destructive">
        Could not load SSH settings.
      </p>
    );
  }
  const connection =
    connections.data.find(
      (candidate) => candidate.profile.hostId === props.hostId,
    ) ?? null;
  return <SshHostConnectionForm {...props} connection={connection} />;
}

function SshHostConnectionForm(props: {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly connection: SshHostConnection | null;
}) {
  const inputId = useId();
  // A draft belongs to this host's keyed settings panel. Null means untouched,
  // so a saved profile arriving from another window updates the input too.
  const [draft, setDraft] = useState<string | null>(null);
  const target = draft ?? props.connection?.profile.target ?? "";
  const change = useRunnerChangeSshHost(props.hostId);
  const pendingKind = change.isPending ? change.variables.kind : null;
  const error = change.error?.message ?? props.connection?.message ?? null;
  return (
    <section
      aria-label="SSH connection"
      className="mb-5 space-y-3 rounded-lg border border-border/60 bg-card/40 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-sm font-medium">Connection</h2>
        <Badge variant="outline">
          {props.connection === null
            ? "Traycer connection"
            : CONNECTION_LABEL[props.connection.state]}
        </Badge>
      </div>
      <p className="text-ui-sm text-muted-foreground">
        Connect to {props.hostLabel} through SSH using your Windows OpenSSH
        profile. Your account, subscription and existing Linux Host stay in use.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate({
            kind: "save",
            profile: {
              hostId: props.hostId,
              label: props.hostLabel,
              target: target.trim(),
            },
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor={inputId}>SSH target</Label>
          <Input
            id={inputId}
            value={target}
            placeholder="linux-dev or user@hostname"
            autoComplete="off"
            spellCheck={false}
            disabled={change.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="text-ui-xs text-muted-foreground">
            Set up key authentication and accept the server key with ssh in
            Windows Terminal first.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={change.isPending || target.trim().length === 0}
          >
            Use SSH
            <SshChangeSpinner active={pendingKind === "save"} />
          </Button>
          {props.connection === null ? null : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({ kind: "reconnect" })}
              >
                Reconnect SSH
                <SshChangeSpinner active={pendingKind === "reconnect"} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({ kind: "remove" })}
              >
                Use Traycer connection
                <SshChangeSpinner active={pendingKind === "remove"} />
              </Button>
            </>
          )}
        </div>
        {error === null ? null : (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
