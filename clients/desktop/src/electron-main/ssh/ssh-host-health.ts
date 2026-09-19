import { request } from "node:http";

/** A TCP connect can succeed while the Host event loop is stuck. Wait for HTTP. */
export function probeSshHost(
  websocketUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const url = new URL(websocketUrl);
    // Only the manager's local SSH forwarding endpoint is probed. No proxy,
    // bearer, RPC or account request is involved; even a 404 proves liveness.
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
      resolve(false);
      return;
    }
    url.protocol = "http:";
    const req = request(url, { method: "GET", agent: false, signal });
    const deadline = setTimeout(() => finish(false), 8_000);
    let settled = false;
    function finish(healthy: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(healthy);
    }
    req.once("response", (response) => {
      response.destroy();
      finish(true);
    });
    req.once("error", () => finish(false));
    req.end();
  });
}
