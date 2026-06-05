import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

type AdapterHandle = {
  httpServer: http.Server;
  stop: () => void;
};

type AdapterModule = {
  startAdapter: () => AdapterHandle;
};

const originalHome = process.env.HOME;
const originalPort = process.env.HERMES_ADAPTER_PORT;
const tempHomes: string[] = [];
const adapterHandles: AdapterHandle[] = [];

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-logging-home-"));
  tempHomes.push(home);
  return home;
};

const waitForListening = async (server: http.Server) => {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
};

const waitForStatusResponse = async (url: string) => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for adapter status response."));
    }, 3000);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) {
        ws.terminate();
        reject(err);
        return;
      }
      ws.once("close", () => {
        setTimeout(resolve, 25);
      });
      ws.close();
    };

    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        type?: string;
        event?: string;
        id?: string;
      };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        ws.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 4,
              client: { id: "logging-test", mode: "webchat" },
              role: "operator",
              scopes: ["operator.read", "operator.admin"],
            },
          })
        );
        return;
      }
      if (frame.type === "res" && frame.id === "connect") {
        ws.send(JSON.stringify({ type: "req", id: "status", method: "status", params: {} }));
        return;
      }
      if (frame.type === "res" && frame.id === "status") {
        finish();
      }
    });
    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
};

const startAdapter = async () => {
  vi.resetModules();
  process.env.HOME = makeHome();
  process.env.HERMES_ADAPTER_PORT = "0";
  const adapter = (await import("../../server/hermes-gateway-adapter.js")) as AdapterModule;
  const handle = adapter.startAdapter();
  adapterHandles.push(handle);
  await waitForListening(handle.httpServer);
  const address = handle.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Adapter did not bind to a TCP port.");
  }
  return { handle, url: `ws://127.0.0.1:${address.port}` };
};

afterEach(async () => {
  while (adapterHandles.length > 0) {
    const handle = adapterHandles.pop();
    handle?.stop();
    if (handle?.httpServer.listening) {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  }
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPort === undefined) delete process.env.HERMES_ADAPTER_PORT;
  else process.env.HERMES_ADAPTER_PORT = originalPort;
});

describe("hermes gateway adapter logging", () => {
  it("logs WebSocket connection, gateway connect, and method completion", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { url } = await startAdapter();

    await waitForStatusResponse(url);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContainEqual(
      expect.stringMatching(/\[hermes-adapter] WebSocket client connected active=1/)
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /\[hermes-adapter] Gateway connect ok client\.id=logging-test mode=webchat protocol=3 agents=1/
      )
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/\[hermes-adapter] Method status ok durationMs=\d+/)
    );
  });
});
