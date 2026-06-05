import fs from "node:fs";
import http from "node:http";
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cron-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cron-workspace-"));
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
        if (body.stream === true) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "Hermes completed the scheduled work." } }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })}\n\n`
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Hermes completed the scheduled work." } }],
        }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  fakeServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
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
  throw new Error("Timed out waiting for expected adapter event.");
};

afterEach(async () => {
  vi.resetModules();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.HERMES_ADAPTER_STATE_DIR;
  } else {
    process.env.HERMES_ADAPTER_STATE_DIR = originalStateDir;
  }
  if (originalHermesApiUrl === undefined) {
    delete process.env.HERMES_API_URL;
  } else {
    process.env.HERMES_API_URL = originalHermesApiUrl;
  }
  if (originalHermesModel === undefined) {
    delete process.env.HERMES_MODEL;
  } else {
    process.env.HERMES_MODEL = originalHermesModel;
  }

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

describe("hermes-gateway-adapter cron and heartbeat runs", () => {
  it("runs cron jobs through chat and updates job state", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const workspace = makeWorkspace();
    const events: EventFrame[] = [];
    const sendEvent = (frame: EventFrame) => events.push(frame);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Cron Runner",
      workspace,
    });
    const sessionKey = `agent:${created.agentId}:main`;
    const job = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "Morning check",
      agentId: created.agentId,
      sessionKey,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run the scheduled check." },
    });

    const run = await callGateway<{ ok: true; ran: true; runId: string }>(
      adapter,
      "cron.run",
      { id: job.id, mode: "force" },
      sendEvent
    );

    expect(run).toMatchObject({ ok: true, ran: true });
    expect(run.runId).toEqual(expect.any(String));
    await callGateway(adapter, "agent.wait", { runId: run.runId, timeoutMs: 5000 });
    await waitFor(() => events.some((event) => event.event === "chat" && event.payload?.state === "final"));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "cron",
          payload: expect.objectContaining({ action: "started", jobId: job.id, runId: run.runId }),
        }),
        expect.objectContaining({
          event: "cron",
          payload: expect.objectContaining({ action: "finished", jobId: job.id, status: "ok" }),
        }),
        expect.objectContaining({
          event: "chat",
          payload: expect.objectContaining({ runId: run.runId, sessionKey, state: "final" }),
        }),
      ])
    );
    expect(fakeHermes.requests[0]?.body).toMatchObject({
      model: "hermes-test-model",
      stream: true,
    });
    expect(JSON.stringify(fakeHermes.requests[0]?.body.messages)).toContain("Run the scheduled check.");

    const listed = await callGateway<{
      jobs: Array<{
        id: string;
        state: { lastStatus?: string; lastRunAtMs?: number; lastDurationMs?: number };
      }>;
    }>(adapter, "cron.list");
    const updated = listed.jobs.find((entry) => entry.id === job.id);
    expect(updated?.state).toMatchObject({
      lastStatus: "ok",
      lastRunAtMs: expect.any(Number),
      lastDurationMs: expect.any(Number),
    });
  });

  it("reports heartbeat status and wake creates a heartbeat chat session", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const events: EventFrame[] = [];
    const sendEvent = (frame: EventFrame) => events.push(frame);
    const workspace = makeWorkspace();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Heartbeat Runner",
      workspace,
    });

    const snapshot = await callGateway<{
      config: { agents?: { list?: Array<Record<string, unknown>> } };
      hash: string;
    }>(adapter, "config.get");
    const list = (snapshot.config.agents?.list ?? []).map((entry) =>
      entry.id === created.agentId
        ? { ...entry, heartbeat: { every: "15m", target: "last", includeReasoning: true } }
        : entry
    );
    await callGateway(adapter, "config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({
        agents: {
          defaults: { heartbeat: { every: "30m", target: "last", includeReasoning: false } },
          list,
        },
      }),
    });

    const status = await callGateway<{
      heartbeat?: { agents?: Array<{ agentId: string; enabled: boolean; every?: string }> };
    }>(adapter, "status");
    expect(status.heartbeat?.agents).toContainEqual(
      expect.objectContaining({ agentId: created.agentId, enabled: true, every: "15m" })
    );

    const wake = await callGateway<{ ok: true; runId: string }>(
      adapter,
      "wake",
      { mode: "now", text: `Claw3D heartbeat trigger (${created.agentId}).` },
      sendEvent
    );
    expect(wake).toMatchObject({ ok: true, runId: expect.any(String) });
    await callGateway(adapter, "agent.wait", { runId: wake.runId, timeoutMs: 5000 });
    await waitFor(() => events.some((event) => event.event === "heartbeat"));

    const heartbeatSessionKey = `agent:${created.agentId}:heartbeat`;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "heartbeat",
          payload: expect.objectContaining({
            agentId: created.agentId,
            sessionKey: heartbeatSessionKey,
            runId: wake.runId,
          }),
        }),
        expect.objectContaining({
          event: "chat",
          payload: expect.objectContaining({
            runId: wake.runId,
            sessionKey: heartbeatSessionKey,
            state: "final",
          }),
        }),
      ])
    );

    const sessions = await callGateway<{
      sessions: Array<{ key: string; displayName: string; origin?: { label?: string } }>;
    }>(adapter, "sessions.list");
    expect(sessions.sessions).toContainEqual(
      expect.objectContaining({
        key: heartbeatSessionKey,
        displayName: "Heartbeat",
        origin: expect.objectContaining({ label: "heartbeat" }),
      })
    );
  });
});
