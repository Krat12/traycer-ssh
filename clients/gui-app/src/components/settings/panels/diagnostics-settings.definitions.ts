import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// The Log detail card is dropped for a host too old to answer the log-level
// RPC, so it and its rows fold into the page.
export const HOST_DIAGNOSTICS = defineSettingsSection("diagnostics", {
  page: {
    label: "Diagnostics",
    description:
      "Log verbosity and recent log output for the host selected above.",
    keywords: [
      "logs",
      "debug",
      "verbose",
      "troubleshoot",
      "host",
      "cli",
      "support",
      "log file",
      "log detail",
      "log level",
      "cli log level",
      "host log level",
      "verbosity",
      "trace",
      "logging",
    ],
  },
  logDetail: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Log detail",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Both rows are named per machine, not per host: the store is
  // `~/.traycer/cli/config.json`, shared by every Traycer host environment
  // this OS user runs.
  cliLogLevel: {
    kind: "row",
    group: "logDetail",
    search: { contributesTo: "page" },
    label: "CLI log level",
    description:
      "Verbosity of the Traycer CLI's logs. Applies to every Traycer host environment on this machine.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  hostLogLevel: {
    kind: "row",
    group: "logDetail",
    search: { contributesTo: "page" },
    label: "Host log level",
    description:
      "Verbosity of the background host process's logs. Applies to every Traycer host environment on this machine.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Host-scoped like `logDetail` above, but a fact of the machine rather than
  // its logs — its own card so a host too old for `config.hostSettings.get`
  // drops just this row (see `HostVideoPlaneRow`), not the log-level card too.
  advanced: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Advanced",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  videoPlane: {
    kind: "row",
    group: "advanced",
    search: { contributesTo: "page" },
    label: "Low-latency video for remote viewing",
    // Deliberately reads as a feature switch, not a permission grant: the row
    // turns streaming on, and macOS is what asks for the two permissions as a
    // consequence. Users read a tri-state in Settings as "I granted this" and
    // then wonder why the OS asks anyway (mobile-browser research/10 RC-A).
    // Host-agnostic, because this same string is the settings-search index
    // entry; `HostVideoPlaneRow` names the selected host in its live status.
    description:
      "Streams this host's browser tabs to your phone and other devices over WebRTC instead of images, which is smoother on a good network. Turning it on is what makes a macOS host ask for Screen Recording and Local Network access — this switch does not grant them, macOS still asks, and you can turn it back off. Off keeps tabs streaming as images.",
    availableWhen: alwaysAvailable,
    keywords: [
      "webrtc",
      "video",
      "screen recording",
      "local network",
      "browser",
      "remote",
      "phone",
      "mobile",
    ],
  },
});
