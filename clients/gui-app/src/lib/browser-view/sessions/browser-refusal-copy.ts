import {
  BROWSER_DESKTOP_UPDATE_REQUIRED_REASON,
  BROWSER_MIRROR_UNAVAILABLE_REASON,
} from "@traycer/protocol/host/browser/contracts";
import { readHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-connection-registry";

/**
 * Reader-facing copy for the two reasons a host refuses to serve a browser
 * tab (D06), wherever that refusal lands - a `refused` screencast frame or an
 * `openTabResult { ok: false }`.
 *
 * Both remedies name a MACHINE, so the copy needs its label rather than the
 * id the wire carries; the two reasons differ in which remedy they ask for
 * ("update the desktop" vs "its mirror is broken right now"), which is the
 * whole reason the host writes two constants instead of one string. Every
 * other reason is free-form and is shown verbatim, as it always was.
 */
export function browserRefusalMessage(reason: string, hostId: string): string {
  if (reason === BROWSER_DESKTOP_UPDATE_REQUIRED_REASON) {
    return `Update Traycer on ${browserRefusalHostLabel(hostId)} to view browser tabs from your phone`;
  }
  if (reason === BROWSER_MIRROR_UNAVAILABLE_REASON) {
    return `Restart Traycer on ${browserRefusalHostLabel(hostId)} to view this tab`;
  }
  return reason;
}

/**
 * The host's own name where the directory has one, and its id otherwise.
 *
 * Read context-free (`readHostDirectoryEntry`) rather than through
 * `useHostDirectoryEntry`: one of the two call sites is the sessions
 * coordinator's frame router, which is not a component and holds only the id.
 */
function browserRefusalHostLabel(hostId: string): string {
  const label = readHostDirectoryEntry(hostId)?.label ?? "";
  return label.length > 0 ? label : hostId;
}
