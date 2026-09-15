// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSshTransport } from "../openssh-transport";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

class FakeSshChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => {
      this.emit("close", null);
    });
    return true;
  });
}

const profile = { hostId: "linux-host", label: "Linux", target: "dev-vm" };
const children: FakeSshChild[] = [];
const controllers: AbortController[] = [];

function connect() {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    result: new OpenSshTransport().connect(profile, controller.signal),
  };
}

async function discover(): Promise<FakeSshChild> {
  const child = children[0]!;
  child.stdout.write(
    JSON.stringify({
      hostId: profile.hostId,
      websocketUrl: "ws://127.0.0.1:7777/rpc",
      version: "1.2.3",
    }),
  );
  child.emit("close", 0);
  await vi.waitFor(() => {
    expect(children).toHaveLength(2);
  });
  return children[1]!;
}

beforeEach(() => {
  children.length = 0;
  mock.spawn.mockReset().mockImplementation(() => {
    const child = new FakeSshChild();
    children.push(child);
    return child;
  });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.useRealTimers();
});

describe("OpenSSH subprocess lifecycle", () => {
  it("bounds a discovery process that never answers and settles once when it eventually exits", async () => {
    vi.useFakeTimers();
    const { result } = connect();
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    children[0]!.emit("close", 255);
    expect(children[0]?.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
  });

  it("waits for a local forwarding acknowledgement, ignoring spoofed stderr and fragmented stdout", async () => {
    const { result } = connect();
    let ready = false;
    void result.then(() => {
      ready = true;
    });
    const child = await discover();
    child.stderr.write(
      "debug1: Entering interactive session.\nTRAYCER_SSH_FORWARD_READY\n",
    );
    await Promise.resolve();
    expect(ready).toBe(false);
    child.stdout.write("TRAYCER_SSH_FORWARD_");
    await Promise.resolve();
    expect(ready).toBe(false);
    child.stdout.write("READY\r\n");
    const tunnel = await result;
    expect(tunnel.websocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/);
    expect(tunnel.version).toBe("1.2.3");
    tunnel.dispose();
    expect((await tunnel.closed).message).toContain("cancelled");
  });

  it("does not publish a tunnel when its loopback bind fails", async () => {
    const { result } = connect();
    const rejected = expect(result).rejects.toThrow(
      "port forwarding was refused",
    );
    const child = await discover();
    child.stderr.write(
      "bind [127.0.0.1]:12345: Address already in use\nCould not request local forwarding. cannot listen to port: 12345\n",
    );
    child.emit("close", 255);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("reports a later remote connection refusal so manager can rediscover a changed Host port", async () => {
    const { result } = connect();
    const child = await discover();
    child.stdout.write("TRAYCER_SSH_FORWARD_READY\n");
    const tunnel = await result;
    child.stderr.write(
      "channel 2: open failed: connect failed: Connection refused\n",
    );
    expect((await tunnel.closed).retryable).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("aborting discovery kills only its owned process and creates no tunnel", async () => {
    const { controller, result } = connect();
    const rejected = expect(result).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    expect(children).toHaveLength(1);
    expect(children[0]?.kill).toHaveBeenCalledOnce();
  });

  it("refuses a mismatched remote identity before allocating any forwarding process", async () => {
    const { result } = connect();
    const rejected = expect(result).rejects.toThrow("different Host");
    children[0]!.stdout.write(
      JSON.stringify({
        hostId: "impostor",
        websocketUrl: "ws://127.0.0.1:7777/rpc",
      }),
    );
    children[0]!.emit("close", 0);
    await rejected;
    expect(children).toHaveLength(1);
  });
});
