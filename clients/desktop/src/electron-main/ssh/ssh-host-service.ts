import { app } from "electron";
import { join } from "node:path";
import { SshHostManager } from "./ssh-host-manager";
import { FileSshProfileStore } from "./ssh-profile-store";
import { OpenSshTransport } from "./openssh-transport";
import { collectRemoteSshDiagnostic } from "./ssh-remote-diagnostics";

import { probeSshHost } from "./ssh-host-health";

let manager: SshHostManager | null = null;

/** The fork sets userData before requesting this service. */
export function getSshHostManager(): SshHostManager {
  manager ??= new SshHostManager(
    new FileSshProfileStore(join(app.getPath("userData"), "ssh-hosts.json")),
    new OpenSshTransport(),
    (profile) => collectRemoteSshDiagnostic(profile, {}),
    probeSshHost,
  );
  return manager;
}
