import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type GatewayResponse<Payload = Record<string, unknown>> =
  | { type: "res"; ok: true; payload: Payload }
  | { type: "res"; ok: false; error: { code: string; message: string } };

type HermesAdapterModule = {
  handleMethod: (
    method: string,
    params: Record<string, unknown>,
    id: string,
    sendEvent: (frame: object) => void
  ) => Promise<GatewayResponse>;
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
};

const originalHome = process.env.HOME;
const originalStateDir = process.env.HERMES_ADAPTER_STATE_DIR;
const originalHermesApiUrl = process.env.HERMES_API_URL;
const originalHermesModel = process.env.HERMES_MODEL;
const tempHomes: string[] = [];
const tempWorkspaces: string[] = [];
const fakeServers: http.Server[] = [];

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-heartbeat-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-heartbeat-workspace-"));
  tempWorkspaces.push(workspace);
  return workspace;
};

const startFakeHermes = async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "hermes-test-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ path: req.url || "", body });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "heartbeat ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Hermes server did not bind to a TCP port.");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
};

const importAdapter = async (home: string, hermesApiUrl: string): Promise<HermesAdapterModule> => {
  vi.resetModules();
  process.env.HOME = home;
  process.env.HERMES_API_URL = hermesApiUrl;
  process.env.HERMES_MODEL = "hermes-test-model";
  delete process.env.HERMES_ADAPTER_STATE_DIR;
  return (await import("../../server/hermes-gateway-adapter.js")) as HermesAdapterModule;
};

const callGateway = async <Payload = Record<string, unknown>>(
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {},
  sendEvent: (frame: EventFrame) => void = () => {}
): Promise<Payload> => {
  const response = await adapter.handleMethod(
    method,
    params,
    method,
    sendEvent as (frame: object) => void
  );
  expect(response).toMatchObject({ type: "res", ok: true });
  return (response as { payload: Payload }).payload;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2500) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for expected heartbeat state.");
};

afterEach(async () => {
  vi.resetModules();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateDir === undefined) delete process.env.HERMES_ADAPTER_STATE_DIR;
  else process.env.HERMES_ADAPTER_STATE_DIR = originalStateDir;
  if (originalHermesApiUrl === undefined) delete process.env.HERMES_API_URL;
  else process.env.HERMES_API_URL = originalHermesApiUrl;
  if (originalHermesModel === undefined) delete process.env.HERMES_MODEL;
  else process.env.HERMES_MODEL = originalHermesModel;

  while (fakeServers.length > 0) {
    const server = fakeServers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempWorkspaces.length > 0) {
    fs.rmSync(tempWorkspaces.pop()!, { recursive: true, force: true });
  }
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe("hermes-gateway-adapter heartbeat scheduler state", () => {
  it("reports heartbeat interval milliseconds state and persists wake state across reload", async () => {
    const fakeHermes = await startFakeHermes();
    const home = makeHome();
    let adapter = await importAdapter(home, fakeHermes.url);
    const workspace = makeWorkspace();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Heartbeat Scheduler Agent",
      workspace,
    });

    const snapshot = await callGateway<{
      config: { agents?: { list?: Array<Record<string, unknown>> } };
      hash: string;
    }>(adapter, "config.get");
    const list = (snapshot.config.agents?.list ?? []).map((entry) =>
      entry.id === created.agentId ? { ...entry, heartbeat: { every: "5m", target: "last" } } : entry
    );
    await callGateway(adapter, "config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({ agents: { list } }),
    });

    let status = await callGateway<{
      heartbeat?: {
        agents?: Array<{
          agentId: string;
          enabled: boolean;
          every?: string;
          everyMs?: number;
          state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string };
        }>;
      };
    }>(adapter, "status");
    let heartbeat = status.heartbeat?.agents?.find((entry) => entry.agentId === created.agentId);
    expect(heartbeat).toMatchObject({
      agentId: created.agentId,
      enabled: true,
      every: "5m",
      everyMs: 300_000,
      state: { nextRunAtMs: expect.any(Number) },
    });

    const events: EventFrame[] = [];
    const wake = await callGateway<{ ok: true; runId: string }>(
      adapter,
      "wake",
      { agentId: created.agentId, mode: "now", text: "Heartbeat check." },
      (frame) => events.push(frame)
    );
    await callGateway(adapter, "agent.wait", { runId: wake.runId, timeoutMs: 5000 });
    await waitFor(() => events.some((event) => event.event === "heartbeat" && event.payload?.action === "finished"));

    status = await callGateway(adapter, "status");
    heartbeat = status.heartbeat?.agents?.find((entry) => entry.agentId === created.agentId);
    expect(heartbeat?.state).toMatchObject({
      lastStatus: "ok",
      lastRunAtMs: expect.any(Number),
      nextRunAtMs: expect.any(Number),
    });
    expect(heartbeat?.state?.nextRunAtMs).toBeGreaterThan(heartbeat?.state?.lastRunAtMs ?? 0);

    adapter = await importAdapter(home, fakeHermes.url);
    status = await callGateway(adapter, "status");
    heartbeat = status.heartbeat?.agents?.find((entry) => entry.agentId === created.agentId);
    expect(heartbeat?.state).toMatchObject({
      lastStatus: "ok",
      lastRunAtMs: expect.any(Number),
      nextRunAtMs: expect.any(Number),
    });
  });

  it("marks invalid heartbeat intervals disabled without scheduling state", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Invalid Heartbeat Agent",
      workspace: makeWorkspace(),
    });
    const snapshot = await callGateway<{
      config: { agents?: { list?: Array<Record<string, unknown>> } };
      hash: string;
    }>(adapter, "config.get");
    const list = (snapshot.config.agents?.list ?? []).map((entry) =>
      entry.id === created.agentId ? { ...entry, heartbeat: { every: "soon" } } : entry
    );
    await callGateway(adapter, "config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({ agents: { list } }),
    });

    const status = await callGateway<{
      heartbeat?: { agents?: Array<{ agentId: string; enabled: boolean; everyMs?: number; state?: object }> };
    }>(adapter, "status");
    expect(status.heartbeat?.agents).toContainEqual(
      expect.objectContaining({
        agentId: created.agentId,
        enabled: false,
      })
    );
    const heartbeat = status.heartbeat?.agents?.find((entry) => entry.agentId === created.agentId);
    expect(heartbeat?.everyMs).toBeUndefined();
    expect(heartbeat?.state).toEqual({});
  });
});
