import http from "node:http";
import os from "node:os";
import fs from "node:fs";
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-scheduler-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-scheduler-workspace-"));
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
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
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
  throw new Error("Timed out waiting for expected adapter state.");
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

describe("hermes-gateway-adapter scheduler semantics", () => {
  it("sets nextRunAtMs and does not auto-run future jobs", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Scheduler Agent",
      workspace: makeWorkspace(),
    });
    const beforeAdd = Date.now();
    const job = await callGateway<{
      id: string;
      state: { nextRunAtMs?: number };
    }>(adapter, "cron.add", {
      name: "Future interval",
      agentId: created.agentId,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Run later." },
    });

    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(beforeAdd + 59_000);
    expect(job.state.nextRunAtMs).toBeLessThanOrEqual(Date.now() + 61_000);

    const result = await callGateway<{ ok: true; ran: false; reason: string }>(
      adapter,
      "cron.run",
      { id: job.id, mode: "auto" }
    );

    expect(result).toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(fakeHermes.requests).toHaveLength(0);
  });

  it("auto-runs due jobs then requeues every jobs and deletes deleteAfterRun jobs", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const events: EventFrame[] = [];
    const sendEvent = (frame: EventFrame) => events.push(frame);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Due Scheduler Agent",
      workspace: makeWorkspace(),
    });

    const everyJob = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "Due interval",
      agentId: created.agentId,
      schedule: { kind: "every", everyMs: 1000, anchorMs: Date.now() - 5000 },
      payload: { kind: "agentTurn", message: "Run recurring work." },
    });
    const everyRun = await callGateway<{ ok: true; ran: true; runId: string }>(
      adapter,
      "cron.run",
      { id: everyJob.id, mode: "auto" },
      sendEvent
    );
    await callGateway(adapter, "agent.wait", { runId: everyRun.runId, timeoutMs: 5000 });
    await waitFor(() => events.some((event) => event.event === "cron" && event.payload?.action === "finished"));

    let listed = await callGateway<{
      jobs: Array<{ id: string; state: { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string } }>;
    }>(adapter, "cron.list");
    const requeued = listed.jobs.find((job) => job.id === everyJob.id);
    expect(requeued?.state).toMatchObject({ lastStatus: "ok", lastRunAtMs: expect.any(Number) });
    expect(requeued?.state.nextRunAtMs).toBeGreaterThan(requeued?.state.lastRunAtMs ?? 0);

    const onceJob = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "One shot",
      agentId: created.agentId,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      payload: { kind: "agentTurn", message: "Run once." },
    });
    const onceRun = await callGateway<{ ok: true; ran: true; runId: string }>(
      adapter,
      "cron.run",
      { id: onceJob.id, mode: "auto" },
      sendEvent
    );
    await callGateway(adapter, "agent.wait", { runId: onceRun.runId, timeoutMs: 5000 });
    await waitFor(() => fakeHermes.requests.length >= 2);

    listed = await callGateway<{ jobs: Array<{ id: string }> }>(adapter, "cron.list");
    expect(listed.jobs.some((job) => job.id === onceJob.id)).toBe(false);
  });

  it("auto-run skips disabled and already running jobs", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Skip Scheduler Agent",
      workspace: makeWorkspace(),
    });

    const disabledJob = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "Disabled due job",
      agentId: created.agentId,
      enabled: false,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      payload: { kind: "agentTurn", message: "Should not run." },
    });
    const disabledRun = await callGateway<{ ok: true; ran: false; reason: string }>(
      adapter,
      "cron.run",
      { id: disabledJob.id, mode: "auto" }
    );
    expect(disabledRun).toEqual({ ok: true, ran: false, reason: "disabled" });

    const runningJob = await callGateway<{ id: string; state: Record<string, unknown> }>(adapter, "cron.add", {
      name: "Running due job",
      agentId: created.agentId,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      payload: { kind: "agentTurn", message: "Run." },
    });
    await callGateway(adapter, "cron.patch", {
      id: runningJob.id,
      state: { ...runningJob.state, runningAtMs: Date.now() - 1000 },
    });
    const runningRun = await callGateway<{ ok: true; ran: false; reason: string }>(
      adapter,
      "cron.run",
      { id: runningJob.id, mode: "auto" }
    );

    expect(runningRun).toEqual({ ok: true, ran: false, reason: "running" });
    expect(fakeHermes.requests).toHaveLength(0);
  });
});
