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

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  durationMs: number;
};

const originalHome = process.env.HOME;
const originalStateDir = process.env.HERMES_ADAPTER_STATE_DIR;
const originalHermesApiUrl = process.env.HERMES_API_URL;
const originalHermesModel = process.env.HERMES_MODEL;
const tempHomes: string[] = [];
const tempWorkspaces: string[] = [];
const fakeServers: http.Server[] = [];

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-usage-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-usage-workspace-"));
  tempWorkspaces.push(workspace);
  return workspace;
};

const toDate = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

const startFakeHermes = async (options: { usage?: Record<string, unknown> } = {}) => {
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
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hermes usage answer." } }],
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            ...(options.usage ? { usage: options.usage } : {}),
          })}\n\n`
        );
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

const runChat = async (adapter: HermesAdapterModule, agentId: string) => {
  const sessionKey = `agent:${agentId}:main`;
  const run = await callGateway<{ runId: string }>(adapter, "chat.send", {
    sessionKey,
    message: "Summarize usage analytics for Hermes.",
  });
  await callGateway(adapter, "agent.wait", { runId: run.runId, timeoutMs: 5000 });
  return { sessionKey, runId: run.runId };
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

describe("hermes-gateway-adapter usage analytics", () => {
  it("reports chat usage with estimated tokens and zero cost", async () => {
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Usage Agent",
      workspace: makeWorkspace(),
    });
    const { sessionKey } = await runChat(adapter, created.agentId);
    const today = toDate();

    const usage = await callGateway<{
      sessions: Array<{
        key: string;
        agentId: string;
        model: string;
        modelProvider: string;
        updatedAt: number;
        usage: {
          totals: UsageTotals;
          messageCounts: { total: number; user: number; assistant: number };
          modelUsage: Array<{ provider: string; model: string; count: number; totals: UsageTotals }>;
          dailyBreakdown: Array<{ date: string; tokens: number; cost: number }>;
          dailyMessageCounts: Array<{ date: string; total: number }>;
        };
      }>;
      totals: UsageTotals;
      metadata: { runtime: string; tokenSource: string; costSource: string };
    }>(adapter, "sessions.usage", { startDate: today, endDate: today, limit: 100 });

    expect(usage.metadata).toMatchObject({
      runtime: "hermes",
      tokenSource: "estimated",
      costSource: "none",
    });
    expect(usage.sessions).toContainEqual(
      expect.objectContaining({
        key: sessionKey,
        agentId: created.agentId,
        model: "hermes-test-model",
        modelProvider: "hermes",
        updatedAt: expect.any(Number),
        usage: expect.objectContaining({
          messageCounts: expect.objectContaining({ total: 2, user: 1, assistant: 1 }),
        }),
      })
    );
    const session = usage.sessions.find((entry) => entry.key === sessionKey)!;
    expect(session.usage.totals.totalTokens).toBeGreaterThan(0);
    expect(session.usage.totals.totalCost).toBe(0);
    expect(session.usage.modelUsage).toContainEqual(
      expect.objectContaining({
        provider: "hermes",
        model: "hermes-test-model",
        count: 1,
        totals: expect.objectContaining({ totalTokens: session.usage.totals.totalTokens }),
      })
    );
    expect(session.usage.dailyBreakdown).toContainEqual(
      expect.objectContaining({ date: today, tokens: session.usage.totals.totalTokens, cost: 0 })
    );
    expect(session.usage.dailyMessageCounts).toContainEqual(
      expect.objectContaining({ date: today, total: 2 })
    );
    expect(usage.totals.totalTokens).toBe(session.usage.totals.totalTokens);

    const cost = await callGateway<{
      daily: Array<{ date: string; totalTokens: number; totalCost: number }>;
      metadata: { runtime: string; tokenSource: string; costSource: string };
    }>(adapter, "usage.cost", { startDate: today, endDate: today });
    expect(cost.metadata).toMatchObject({
      runtime: "hermes",
      tokenSource: "estimated",
      costSource: "none",
    });
    expect(cost.daily).toContainEqual(
      expect.objectContaining({
        date: today,
        totalTokens: session.usage.totals.totalTokens,
        totalCost: 0,
      })
    );
  });

  it("uses Hermes OpenAI-style usage metadata before token estimates", async () => {
    const fakeHermes = await startFakeHermes({
      usage: {
        prompt_tokens: 7,
        completion_tokens: 11,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });
    const adapter = await importAdapter(makeHome(), fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Metadata Usage Agent",
      workspace: makeWorkspace(),
    });
    const { sessionKey } = await runChat(adapter, created.agentId);
    const today = toDate();

    const usage = await callGateway<{
      sessions: Array<{ key: string; usage: { totals: UsageTotals } }>;
      metadata: { tokenSource: string; costSource: string };
    }>(adapter, "sessions.usage", { startDate: today, endDate: today });

    const session = usage.sessions.find((entry) => entry.key === sessionKey)!;
    expect(usage.metadata).toMatchObject({ tokenSource: "metadata", costSource: "none" });
    expect(session.usage.totals).toMatchObject({
      input: 7,
      output: 11,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 18,
      totalCost: 0,
    });
  });

  it("uses history file mtime for legacy messages without timestamps", async () => {
    const fakeHermes = await startFakeHermes();
    const home = makeHome();
    const historyDir = path.join(home, ".hermes");
    fs.mkdirSync(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, "clawd3d-history.json");
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        "agent:hermes:main": [
          { role: "user", content: "legacy question" },
          { role: "assistant", content: "legacy answer" },
        ],
      }),
      "utf8"
    );
    const legacyMs = Date.UTC(2026, 0, 5, 12, 0, 0);
    fs.utimesSync(historyFile, new Date(legacyMs), new Date(legacyMs));

    const adapter = await importAdapter(home, fakeHermes.url);
    const included = await callGateway<{
      sessions: Array<{ key: string }>;
      metadata: { legacyDateSource: string };
    }>(adapter, "sessions.usage", { startDate: "2026-01-05", endDate: "2026-01-05" });
    expect(included.metadata.legacyDateSource).toBe("history-file-mtime");
    expect(included.sessions).toContainEqual(expect.objectContaining({ key: "agent:hermes:main" }));

    const excluded = await callGateway<{ sessions: Array<{ key: string }> }>(
      adapter,
      "sessions.usage",
      { startDate: "2026-01-06", endDate: "2026-01-06" }
    );
    expect(excluded.sessions).toHaveLength(0);
  });

  it("reports usage from persisted history after adapter reload", async () => {
    const fakeHermes = await startFakeHermes();
    const home = makeHome();
    let adapter = await importAdapter(home, fakeHermes.url);
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Reload Usage Agent",
      workspace: makeWorkspace(),
    });
    const { sessionKey } = await runChat(adapter, created.agentId);
    const historyFile = path.join(home, ".hermes", "clawd3d-history.json");
    await waitFor(() => fs.existsSync(historyFile) && fs.readFileSync(historyFile, "utf8").includes(sessionKey));

    adapter = await importAdapter(home, fakeHermes.url);
    const today = toDate();
    const usage = await callGateway<{
      sessions: Array<{ key: string; usage: { messageCounts: { total: number } } }>;
    }>(adapter, "sessions.usage", { startDate: today, endDate: today });

    expect(usage.sessions).toContainEqual(
      expect.objectContaining({
        key: sessionKey,
        usage: expect.objectContaining({
          messageCounts: expect.objectContaining({ total: 2 }),
        }),
      })
    );
  });
});
