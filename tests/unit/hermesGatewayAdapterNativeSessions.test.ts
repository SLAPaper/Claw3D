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

type CapturedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
};

type EventFrame = {
  type?: string;
  event?: string;
  payload?: Record<string, unknown>;
};

const originalEnv = {
  HOME: process.env.HOME,
  HERMES_ADAPTER_STATE_DIR: process.env.HERMES_ADAPTER_STATE_DIR,
  HERMES_API_URL: process.env.HERMES_API_URL,
  HERMES_API_KEY: process.env.HERMES_API_KEY,
  HERMES_MODEL: process.env.HERMES_MODEL,
  HERMES_PROFILE_API_URL: process.env.HERMES_PROFILE_API_URL,
  HERMES_PROFILE_API_TOKEN: process.env.HERMES_PROFILE_API_TOKEN,
  HERMES_DASHBOARD_SESSION_TOKEN: process.env.HERMES_DASHBOARD_SESSION_TOKEN,
};

const tempHomes: string[] = [];
const fakeServers: http.Server[] = [];

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-session-home-"));
  tempHomes.push(home);
  return home;
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const readBody = async (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : null;
};

const writeJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const writeSse = (res: http.ServerResponse, events: Array<{ event: string; data: unknown }>) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const entry of events) {
    res.write(`event: ${entry.event}\n`);
    res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
  }
  res.end();
};

const startFakeProfiles = async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/profiles") {
      writeJson(res, 200, {
        profiles: [
          { name: "default", is_default: true, path: "/profiles/default", description: "Main" },
          {
            name: "coder",
            is_default: false,
            path: "/profiles/coder",
            description: "Writes code",
            model: "coder-model",
          },
        ],
      });
      return;
    }
    writeJson(res, 404, { detail: "not found" });
  });
  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Profile server did not bind.");
  return `http://127.0.0.1:${address.port}`;
};

const startFakeHermes = async () => {
  const requests: CapturedRequest[] = [];
  const sessions = new Map<string, { id: string; title: string; model?: string; updated_at: string }>();
  const messagesBySession = new Map<string, Array<{ role: string; content: string }>>();

  const server = http.createServer(async (req, res) => {
    const method = req.method || "";
    const url = req.url || "";
    const body = method === "GET" || method === "DELETE" ? null : await readBody(req);
    requests.push({ method, url, headers: req.headers, body });

    if (method === "GET" && url === "/v1/models") {
      writeJson(res, 200, { data: [{ id: "coder-model" }, { id: "hermes-test-model" }] });
      return;
    }
    if (method === "GET" && url === "/api/sessions?limit=100&offset=0") {
      writeJson(res, 200, { object: "list", data: [...sessions.values()] });
      return;
    }
    if (method === "POST" && url === "/api/sessions") {
      const id = String(body?.id || body?.session_id || "");
      sessions.set(id, {
        id,
        title: String(body?.title || "Main"),
        model: typeof body?.model === "string" ? body.model : undefined,
        updated_at: "2026-06-08T12:00:00.000Z",
      });
      messagesBySession.set(id, []);
      writeJson(res, 201, { object: "hermes.session", session: sessions.get(id) });
      return;
    }
    const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|chat\/stream))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const tail = sessionMatch[2] || "";
      if (method === "GET" && !tail) {
        const session = sessions.get(sessionId);
        if (!session) writeJson(res, 404, { detail: "missing session" });
        else writeJson(res, 200, { object: "hermes.session", session });
        return;
      }
      if (method === "GET" && tail === "messages") {
        writeJson(res, 200, {
          object: "list",
          session_id: sessionId,
          data: messagesBySession.get(sessionId) || [],
        });
        return;
      }
      if (method === "POST" && tail === "chat/stream") {
        expect(req.headers["x-hermes-session-key"]).toBe("agent:coder:main");
        expect(body).toMatchObject({
          message: "Use the native session.",
          model: "coder-model",
          profile: "coder",
        });
        const transcript = [
          { role: "user", content: "Use the native session." },
          { role: "assistant", content: "Native session answer." },
        ];
        messagesBySession.set(sessionId, transcript);
        writeSse(res, [
          { event: "run.started", data: { run_id: "native-run" } },
          { event: "assistant.delta", data: { delta: "Native " } },
          { event: "assistant.delta", data: { delta: "session answer." } },
          {
            event: "run.completed",
            data: {
              messages: transcript,
              usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
            },
          },
          { event: "done", data: {} },
        ]);
        return;
      }
      if (method === "DELETE" && !tail) {
        sessions.delete(sessionId);
        messagesBySession.delete(sessionId);
        writeJson(res, 200, { object: "hermes.session.deleted", id: sessionId, deleted: true });
        return;
      }
    }
    if (method === "POST" && url === "/v1/chat/completions") {
      writeSse(res, [
        { event: "message", data: { choices: [{ delta: { content: "Orchestrator fallback." } }] } },
        { event: "message", data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
      ]);
      return;
    }
    writeJson(res, 404, { error: { message: "not found" } });
  });

  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hermes server did not bind.");
  return { url: `http://127.0.0.1:${address.port}`, requests };
};

const startUnavailableHermesSessions = async () => {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const method = req.method || "";
    const url = req.url || "";
    const body = method === "GET" || method === "DELETE" ? null : await readBody(req);
    requests.push({ method, url, headers: req.headers, body });
    if (method === "GET" && url === "/v1/models") {
      writeJson(res, 200, { data: [{ id: "hermes-test-model" }] });
      return;
    }
    if (url.startsWith("/api/sessions")) {
      writeJson(res, 503, { detail: "sessions offline" });
      return;
    }
    writeJson(res, 404, { error: { message: "not found" } });
  });
  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hermes server did not bind.");
  return { url: `http://127.0.0.1:${address.port}`, requests };
};

const importAdapter = async (home: string, hermesApiUrl: string, profileApiUrl: string) => {
  vi.resetModules();
  process.env.HOME = home;
  delete process.env.HERMES_ADAPTER_STATE_DIR;
  process.env.HERMES_API_URL = hermesApiUrl;
  process.env.HERMES_API_KEY = "test-api-key";
  process.env.HERMES_MODEL = "hermes-test-model";
  process.env.HERMES_PROFILE_API_URL = profileApiUrl;
  process.env.HERMES_PROFILE_API_TOKEN = "profile-token";
  process.env.HERMES_DASHBOARD_SESSION_TOKEN = "";
  return (await import("../../server/hermes-gateway-adapter.js")) as HermesAdapterModule;
};

const callGateway = async <Payload = Record<string, unknown>>(
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {},
  sendEvent: (frame: EventFrame) => void = () => {}
): Promise<Payload> => {
  const response = await adapter.handleMethod(method, params, method, sendEvent as (frame: object) => void);
  expect(response).toMatchObject({ type: "res", ok: true });
  return (response as { payload: Payload }).payload;
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv();
  while (fakeServers.length > 0) {
    const server = fakeServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe("hermes-gateway-adapter native sessions", () => {
  it("uses Hermes native sessions and chat streaming for named profiles", async () => {
    const profileUrl = await startFakeProfiles();
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url, profileUrl);
    await callGateway(adapter, "agents.list");

    const sessionKey = "agent:coder:main";
    await callGateway(adapter, "sessions.patch", { key: sessionKey, model: "coder-model", thinkingLevel: "high" });

    const events: EventFrame[] = [];
    const run = await callGateway<{ runId: string }>(
      adapter,
      "chat.send",
      { sessionKey, message: "Use the native session.", idempotencyKey: "native-test-run" },
      (frame) => events.push(frame)
    );
    expect(run).toEqual({ status: "started", runId: "native-test-run" });
    await callGateway(adapter, "agent.wait", { runId: run.runId, timeoutMs: 5000 });

    expect(fakeHermes.requests.map((request) => `${request.method} ${request.url}`)).toContain(
      "POST /api/sessions"
    );
    expect(fakeHermes.requests.map((request) => request.headers.authorization)).toContain("Bearer test-api-key");
    expect(fakeHermes.requests.some((request) => request.url.includes("/chat/stream"))).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "chat",
        payload: expect.objectContaining({
          runId: "native-test-run",
          sessionKey,
          state: "delta",
          message: { role: "assistant", content: "Native " },
        }),
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "chat",
        payload: expect.objectContaining({
          state: "final",
          stopReason: "end_turn",
          message: { role: "assistant", content: "Native session answer." },
        }),
      })
    );

    const history = await callGateway<{ messages: Array<{ role: string; content: string }> }>(
      adapter,
      "chat.history",
      { sessionKey }
    );
    expect(history.messages).toEqual([
      { role: "user", content: "Use the native session." },
      { role: "assistant", content: "Native session answer." },
    ]);

    const preview = await callGateway<{ previews: Array<{ key: string; status: string; items: Array<{ text: string }> }> }>(
      adapter,
      "sessions.preview",
      { keys: [sessionKey], limit: 2 }
    );
    expect(preview.previews).toEqual([
      expect.objectContaining({
        key: sessionKey,
        status: "ok",
        items: [
          expect.objectContaining({ text: "Use the native session." }),
          expect.objectContaining({ text: "Native session answer." }),
        ],
      }),
    ]);

    const listed = await callGateway<{ sessions: Array<{ key: string; model: string }> }>(
      adapter,
      "sessions.list"
    );
    expect(listed.sessions).toContainEqual(expect.objectContaining({ key: sessionKey, model: "coder-model" }));

    await callGateway(adapter, "sessions.reset", { key: sessionKey });
    expect(fakeHermes.requests.map((request) => `${request.method} ${request.url}`)).toContainEqual(
      expect.stringMatching(/^DELETE \/api\/sessions\//)
    );
  });

  it("keeps the default hermes orchestrator on the adapter loop", async () => {
    const profileUrl = await startFakeProfiles();
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url, profileUrl);
    await callGateway(adapter, "agents.list");

    const run = await callGateway<{ runId: string }>(adapter, "chat.send", {
      sessionKey: "agent:hermes:main",
      message: "Use orchestration.",
      idempotencyKey: "main-run",
    });
    await callGateway(adapter, "agent.wait", { runId: run.runId, timeoutMs: 5000 });

    expect(fakeHermes.requests.some((request) => request.url.includes("/chat/stream"))).toBe(false);
    expect(fakeHermes.requests.map((request) => `${request.method} ${request.url}`)).toContain(
      "POST /v1/chat/completions"
    );
  });

  it("mirrors native run transcripts by appending to local usage history", async () => {
    const profileUrl = await startFakeProfiles();
    const fakeHermes = await startFakeHermes();
    const adapter = await importAdapter(makeHome(), fakeHermes.url, profileUrl);
    await callGateway(adapter, "agents.list");

    const sessionKey = "agent:coder:main";
    for (const runId of ["native-usage-1", "native-usage-2"]) {
      const run = await callGateway<{ runId: string }>(adapter, "chat.send", {
        sessionKey,
        message: "Use the native session.",
        idempotencyKey: runId,
      });
      await callGateway(adapter, "agent.wait", { runId: run.runId, timeoutMs: 5000 });
    }

    const usage = await callGateway<{
      sessions: Array<{ key: string; usage: { messageCounts: { total: number; user: number; assistant: number } } }>;
    }>(adapter, "sessions.usage");
    expect(usage.sessions).toContainEqual(
      expect.objectContaining({
        key: sessionKey,
        usage: expect.objectContaining({
          messageCounts: expect.objectContaining({ total: 4, user: 2, assistant: 2 }),
        }),
      })
    );
  });

  it("falls back to adapter session entries when Hermes native sessions are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const profileUrl = await startFakeProfiles();
    const fakeHermes = await startUnavailableHermesSessions();
    const adapter = await importAdapter(makeHome(), fakeHermes.url, profileUrl);
    await callGateway(adapter, "agents.list");

    const listed = await callGateway<{ sessions: Array<{ key: string; model: string }> }>(
      adapter,
      "sessions.list"
    );

    expect(listed.sessions).toContainEqual(expect.objectContaining({ key: "agent:coder:main" }));
    expect(fakeHermes.requests.map((request) => `${request.method} ${request.url}`)).toContain(
      "GET /api/sessions?limit=100&offset=0"
    );
    expect(warn).toHaveBeenCalledWith(
      "[hermes-adapter] Hermes native session API unavailable; using compat fallback:",
      expect.stringContaining("Hermes API GET /api/sessions?limit=100&offset=0 HTTP 503")
    );
  });
});
