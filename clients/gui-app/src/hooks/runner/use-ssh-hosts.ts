import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  SshHostConnection,
  SshHostProfile,
} from "@traycer-clients/shared/platform/ssh-host";
import { sshHostKeys } from "@/lib/query-keys/ssh-host-keys";
import { useRunnerHost } from "@/providers/use-runner-host";

export function useRunnerSshHosts(): UseQueryResult<
  readonly SshHostConnection[]
> {
  const manager = useRunnerHost().sshHosts ?? null;
  const queryClient = useQueryClient();
  useEffect(() => {
    if (manager === null) return;
    const subscription = manager.onChange(() => {
      void queryClient.invalidateQueries({
        queryKey: sshHostKeys.list(manager),
      });
    });
    return () => subscription.dispose();
  }, [manager, queryClient]);
  return useQuery(
    queryOptions({
      queryKey: sshHostKeys.list(manager),
      queryFn: () => {
        if (manager === null)
          throw new Error("SSH is unavailable in this app.");
        return manager.list();
      },
      enabled: manager !== null,
    }),
  );
}

type SshHostChange =
  | { readonly kind: "save"; readonly profile: SshHostProfile }
  | { readonly kind: "remove" }
  | { readonly kind: "reconnect" };

/** The connection card renders errors inline, beside the target being edited. */
export function useRunnerChangeSshHost(
  hostId: string,
): UseMutationResult<void, Error, SshHostChange> {
  const manager = useRunnerHost().sshHosts ?? null;
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: sshHostKeys.change(hostId),
    mutationFn: (change: SshHostChange) => {
      if (manager === null) throw new Error("SSH is unavailable in this app.");
      switch (change.kind) {
        case "save":
          return manager.save(change.profile);
        case "remove":
          return manager.remove(hostId);
        case "reconnect":
          return manager.reconnect(hostId);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sshHostKeys.list(manager),
      });
    },
  });
}
