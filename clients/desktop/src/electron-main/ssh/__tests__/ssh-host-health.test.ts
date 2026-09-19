// @vitest-environment node
import { createServer } from "node:http";
import { type Socket, createServer as createTcpServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { probeSshHost } from "../ssh-host-health";

describe("SSH Host HTTP liveness", () => {
  it("accepts an HTTP 404 without credentials and closes the connection", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/rpc");
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    try {
      expect(
        await probeSshHost(
          `ws://127.0.0.1:${address.port}/rpc`,
          new AbortController().signal,
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a real accepted TCP connection that sends no HTTP response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sockets: Socket[] = [];
    let accepted: () => void = () => {};
    const connected = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const server = createTcpServer((socket) => {
      sockets.push(socket);
      accepted();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    try {
      const probe = probeSshHost(
        `ws://127.0.0.1:${address.port}/rpc`,
        new AbortController().signal,
      );
      await connected;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await probe).toBe(false);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not mistake TCP acceptance for liveness and cancels an in-flight probe", async () => {
    const accepted = new AbortController();
    const server = createTcpServer((socket) => {
      accepted.abort();
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    try {
      expect(
        await probeSshHost(
          `ws://127.0.0.1:${address.port}/rpc`,
          accepted.signal,
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
