import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HOST_DIAGNOSTICS } from "@/components/settings/panels/diagnostics-settings.definitions";
import { formatPlatform } from "@/components/settings/host-scope/host-scope-model";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { configMutationKeys } from "@/lib/query-keys";

/**
 * D11/T14's gate method. A host that predates it fails
 * `useHostMethodSupport` and this row renders nothing — not a disabled
 * placeholder — same as `LOG_LEVELS_GATE_METHOD` in
 * `diagnostics-settings-panel.tsx`.
 */
export const HOST_SETTINGS_GATE_METHOD = "config.hostSettings.get";

const OPTION_DEFAULT = "default";
const OPTION_ON = "on";
const OPTION_OFF = "off";

type VideoPlaneOption =
  | typeof OPTION_DEFAULT
  | typeof OPTION_ON
  | typeof OPTION_OFF;

function isVideoPlaneOption(value: string): value is VideoPlaneOption {
  return (
    value === OPTION_DEFAULT || value === OPTION_ON || value === OPTION_OFF
  );
}

function optionFor(
  value: boolean | null | undefined,
): VideoPlaneOption | undefined {
  if (value === undefined) return undefined;
  if (value === null) return OPTION_DEFAULT;
  return value ? OPTION_ON : OPTION_OFF;
}

function storedValueFor(option: VideoPlaneOption): boolean | null {
  if (option === OPTION_DEFAULT) return null;
  return option === OPTION_ON;
}

/**
 * D11's host setting, "Low-latency video for remote viewing" — read/written
 * over THIS host's own `config.hostSettings.*` RPC.
 *
 * Wholly host-scoped, deliberately not wired through
 * `useRunnerFeatureSettingsQuery`: that hook reads the DESKTOP MACHINE's own
 * local config over Electron IPC, which is a different answer than the
 * selected host's for a remote host, and even for a local one is a distinct
 * config family (`featureSettingsSchema`) that also has a host-side reader.
 * Reusing it here would give one key two meanings (critique finding 19).
 *
 * The stored value is `boolean | null`, `null` meaning "platform default" —
 * rendered honestly as a three-way choice rather than a switch that can't
 * represent "unset". The response's `effective` field is what lets the
 * default option say what it currently resolves to without this client ever
 * knowing the host's platform.
 */
export function HostVideoPlaneRow(props: {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Whether the surrounding scope is otherwise usable (mirrors the panel's `usable`). */
  readonly enabled: boolean;
  readonly hostPlatform: string | null;
  /**
   * The selected host's display name (`scope.hostLabel`). The setting is
   * written over THAT host's RPC and nothing else's, so the row has to say
   * which machine will be doing the asking - a write made while another host
   * was selected silently never reaches the Mac (research/10 §(d) 4).
   */
  readonly hostName: string;
}): ReactNode {
  const supported = useHostMethodSupport(
    props.hostId,
    HOST_SETTINGS_GATE_METHOD,
  );
  const queryEnabled =
    props.enabled && supported === true && props.client !== null;
  const query = useHostQuery<HostRpcRegistry, "config.hostSettings.get">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "config.hostSettings.get",
    params: {},
    options: { enabled: queryEnabled },
  });
  const setMutation = useHostScopedMutationForClient(props.client, {
    method: "config.hostSettings.set",
    mutationKey: configMutationKeys.hostSettingsSet(),
    errorMessage: "Couldn't update video setting",
    invalidateMethods: ["config.hostSettings.get"],
  });

  if (supported !== true) return null;

  const data = query.data;
  const busy = query.isPending || query.isError || setMutation.isPending;
  const platformWord = formatPlatform(props.hostPlatform);
  const defaultLabel =
    data === undefined
      ? "Platform default"
      : `Platform default (${data.effective ? "on" : "off"}${
          platformWord === null ? "" : ` on ${platformWord}`
        })`;

  return (
    <SettingsGroup
      group={HOST_DIAGNOSTICS.definitions.advanced}
      showTitle
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        row={HOST_DIAGNOSTICS.definitions.videoPlane}
        // The definition's own copy plus the host sentence: the static string
        // stays the searchable one (it is the settings-search index entry, so
        // it cannot name a host), this is what the row actually shows.
        status={
          <>
            {HOST_DIAGNOSTICS.definitions.videoPlane.description}{" "}
            {`Applies to ${props.hostName} only. Other hosts keep their own setting.`}
          </>
        }
        control={
          <Select
            value={optionFor(data?.browserVideoPlane)}
            disabled={busy}
            onValueChange={(next) => {
              if (!isVideoPlaneOption(next)) return;
              void setMutation
                .mutateAsync({ browserVideoPlane: storedValueFor(next) })
                .catch(() => {
                  // The mutation's own transport already toasted this — a
                  // rejection here is that same failure travelling back out
                  // of `mutateAsync`.
                });
            }}
          >
            <SelectTrigger
              className="w-[min(60vw,17rem)]"
              aria-label={HOST_DIAGNOSTICS.definitions.videoPlane.label}
              data-testid="settings-host-video-plane"
            >
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OPTION_DEFAULT}>{defaultLabel}</SelectItem>
              <SelectItem value={OPTION_ON}>On</SelectItem>
              <SelectItem value={OPTION_OFF}>Off</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroup>
  );
}
