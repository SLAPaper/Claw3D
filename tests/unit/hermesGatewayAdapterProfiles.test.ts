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

type ProfileRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

type ProfileHandlerResult = {
  status?: number;
  body?: unknown;
};

const originalEnv = {
  HOME: process.env.HOME,
  HERMES_ADAPTER_STATE_DIR: process.env.HERMES_ADAPTER_STATE_DIR,
  HERMES_PROFILE_API_URL: process.env.HERMES_PROFILE_API_URL,
  HERMES_PROFILE_API_TOKEN: process.env.HERMES_PROFILE_API_TOKEN,
  HERMES_DASHBOARD_SESSION_TOKEN: process.env.HERMES_DASHBOARD_SESSION_TOKEN,
};

const tempHomes: string[] = [];
const fakeServers: http.Server[] = [];
const sendEvent = () => {};

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profile-home-"));
  tempHomes.push(home);
  return home;
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const startFakeProfiles = async (
  handler: (request: ProfileRequest) => ProfileHandlerResult
) => {
  const requests: ProfileRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      let body: unknown = null;
      const rawBody = Buffer.concat(chunks).toString("utf8").trim();
      if (rawBody) body = JSON.parse(rawBody);
      const request = {
        method: req.method || "",
        url: req.url || "",
        headers: req.headers,
        body,
      };
      requests.push(request);
      try {
        const result = handler(request);
        res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body ?? { ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: err instanceof Error ? err.message : String(err) }));
      }
    });
  });
  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake profile server did not bind to a TCP port.");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
};

const importAdapter = async (
  home: string,
  profileApiUrl?: string,
  profileApiToken?: string
): Promise<HermesAdapterModule> => {
  vi.resetModules();
  process.env.HOME = home;
  delete process.env.HERMES_ADAPTER_STATE_DIR;
  process.env.HERMES_PROFILE_API_URL = profileApiUrl ?? "";
  process.env.HERMES_PROFILE_API_TOKEN = profileApiToken ?? "";
  process.env.HERMES_DASHBOARD_SESSION_TOKEN = "";
  return (await import("../../server/hermes-gateway-adapter.js")) as HermesAdapterModule;
};

const callGateway = async <Payload = Record<string, unknown>>(
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Payload> => {
  const response = await adapter.handleMethod(method, params, method, sendEvent);
  expect(response).toMatchObject({ type: "res", ok: true });
  return (response as { payload: Payload }).payload;
};

const callGatewayRaw = async (
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {}
) => adapter.handleMethod(method, params, method, sendEvent);

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

describe("hermes profile client", () => {
  it("calls Dashboard profile CRUD endpoints with the configured token", async () => {
    const { url, requests } = await startFakeProfiles((request) => {
      if (request.method === "GET" && request.url === "/api/profiles") {
        return {
          body: {
            profiles: [
              {
                name: "default",
                path: "/Users/test/.hermes",
                is_default: true,
                description: "Default profile",
              },
            ],
          },
        };
      }
      if (request.method === "POST" && request.url === "/api/profiles") {
        return { body: { ok: true, name: "writer", path: "/Users/test/.hermes/profiles/writer" } };
      }
      if (request.method === "PUT" && request.url === "/api/profiles/writer/description") {
        return { body: { ok: true } };
      }
      if (request.method === "PATCH" && request.url === "/api/profiles/writer") {
        return { body: { ok: true, name: "editor", path: "/Users/test/.hermes/profiles/editor" } };
      }
      if (request.method === "DELETE" && request.url === "/api/profiles/editor") {
        return { body: { ok: true } };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    vi.resetModules();
    process.env.HOME = makeHome();
    process.env.HERMES_PROFILE_API_URL = url;
    process.env.HERMES_PROFILE_API_TOKEN = "profile-token";
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = "";

    const [{ createConfig }, { createUtils }, { createProfiles }] = await Promise.all([
      import("../../server/hermes-adapter/config.js"),
      import("../../server/hermes-adapter/utils.js"),
      import("../../server/hermes-adapter/profiles.js"),
    ]);
    const config = createConfig();
    const profiles = createProfiles(config, createUtils(config));

    await expect(profiles.listProfiles()).resolves.toEqual([
      expect.objectContaining({ name: "default", isDefault: true, description: "Default profile" }),
    ]);
    await expect(
      profiles.createProfile({
        name: "Writer",
        description: "Writes drafts",
        cloneFromDefault: true,
      })
    ).resolves.toEqual(expect.objectContaining({ name: "writer", isDefault: false }));
    await profiles.updateProfileDescription("writer", "Edits drafts");
    await profiles.renameProfile("writer", "Editor");
    await profiles.deleteProfile("editor");

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/profiles",
      "POST /api/profiles",
      "PUT /api/profiles/writer/description",
      "PATCH /api/profiles/writer",
      "DELETE /api/profiles/editor",
    ]);
    expect(requests.map((request) => request.headers["x-hermes-session-token"])).toEqual([
      "profile-token",
      "profile-token",
      "profile-token",
      "profile-token",
      "profile-token",
    ]);
    expect(requests[1]?.body).toEqual({
      name: "writer",
      clone_from_default: true,
      description: "Writes drafts",
    });
    expect(requests[2]?.body).toEqual({ description: "Edits drafts" });
    expect(requests[3]?.body).toEqual({ new_name: "editor" });
  });

  it("uses the Dashboard session token fallback and reports HTTP errors", async () => {
    const { url, requests } = await startFakeProfiles(() => ({
      status: 503,
      body: { detail: "dashboard unavailable" },
    }));
    vi.resetModules();
    process.env.HOME = makeHome();
    process.env.HERMES_PROFILE_API_URL = url;
    process.env.HERMES_PROFILE_API_TOKEN = "";
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = "fallback-session-token";

    const [{ createConfig }, { createUtils }, { createProfiles }] = await Promise.all([
      import("../../server/hermes-adapter/config.js"),
      import("../../server/hermes-adapter/utils.js"),
      import("../../server/hermes-adapter/profiles.js"),
    ]);
    const config = createConfig();
    const profiles = createProfiles(config, createUtils(config));

    await expect(profiles.listProfiles()).rejects.toThrow(
      "Hermes profile API GET /api/profiles failed with 503: dashboard unavailable"
    );
    expect(requests[0]?.headers["x-hermes-session-token"]).toBe("fallback-session-token");
  });
});

describe("hermes-gateway-adapter profile-backed agents", () => {
  it("lists Hermes profiles as gateway agents and synthesizes config agents", async () => {
    const { url, requests } = await startFakeProfiles((request) => {
      expect(request.headers["x-hermes-session-token"]).toBe("profile-token");
      if (request.method === "GET" && request.url === "/api/profiles") {
        return {
          body: {
            profiles: [
              {
                name: "default",
                path: "/Users/test/.hermes",
                is_default: true,
                description: "Primary operator",
                model: "hermes-main",
                provider: "openai",
                skill_count: 4,
                gateway_running: true,
              },
              {
                name: "coder",
                path: "/Users/test/.hermes/profiles/coder",
                is_default: false,
                description: "Writes code",
                model: "hermes-coder",
                provider: "anthropic",
                skill_count: 2,
                gateway_running: false,
              },
            ],
          },
        };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    const adapter = await importAdapter(makeHome(), url, "profile-token");

    const listed = await callGateway<{
      agents: Array<{
        id: string;
        name: string;
        role?: string;
        workspace?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(adapter, "agents.list");
    expect(listed.agents).toEqual([
      expect.objectContaining({
        id: "hermes",
        name: "Hermes",
        role: "Primary operator",
        workspace: "/Users/test/.hermes",
        metadata: expect.objectContaining({ hermesProfileName: "default" }),
      }),
      expect.objectContaining({
        id: "coder",
        name: "coder",
        role: "Writes code",
        workspace: "/Users/test/.hermes/profiles/coder",
        metadata: expect.objectContaining({ hermesProfileName: "coder" }),
      }),
    ]);

    const configSnapshot = await callGateway<{
      config: { agents?: { list?: Array<{ id?: string; role?: string }> } };
    }>(adapter, "config.get");
    expect(configSnapshot.config.agents?.list).toEqual([
      expect.objectContaining({ id: "hermes", role: "Primary operator" }),
      expect.objectContaining({ id: "coder", role: "Writes code" }),
    ]);
    expect(requests.filter((request) => request.url === "/api/profiles")).toHaveLength(2);
  });

  it("creates a named Hermes profile for explicit agents.create calls", async () => {
    const { url, requests } = await startFakeProfiles((request) => {
      if (request.method === "POST" && request.url === "/api/profiles") {
        expect(request.body).toEqual({
          name: "backend-dev",
          clone_from_default: true,
          description: "Backend specialist",
        });
        return {
          body: {
            ok: true,
            name: "backend-dev",
            path: "/Users/test/.hermes/profiles/backend-dev",
          },
        };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    const adapter = await importAdapter(makeHome(), url, "profile-token");

    const created = await callGateway<{
      agentId: string;
      name: string;
      workspace: string;
      metadata?: Record<string, unknown>;
    }>(adapter, "agents.create", {
      name: "Backend Dev",
      role: "Backend specialist",
      workspace: "/ignored/by/profile/mode",
    });

    expect(created).toEqual({
      agentId: "backend-dev",
      name: "Backend Dev",
      workspace: "/Users/test/.hermes/profiles/backend-dev",
      metadata: { hermesProfileName: "backend-dev" },
    });
    expect(requests).toHaveLength(1);
  });

  it("updates profile descriptions and renames non-default profiles with local key migration", async () => {
    const profiles = [
      {
        name: "coder",
        path: "/Users/test/.hermes/profiles/coder",
        is_default: false,
        description: "Writes code",
        model: "hermes-coder",
      },
    ];
    const { url } = await startFakeProfiles((request) => {
      if (request.method === "GET" && request.url === "/api/profiles") {
        return { body: { profiles } };
      }
      if (request.method === "PUT" && request.url === "/api/profiles/coder/description") {
        expect(request.body).toEqual({ description: "Reviews code" });
        profiles[0].description = "Reviews code";
        return { body: { ok: true } };
      }
      if (request.method === "PATCH" && request.url === "/api/profiles/coder") {
        expect(request.body).toEqual({ new_name: "qa-lead" });
        profiles[0] = {
          ...profiles[0],
          name: "qa-lead",
          path: "/Users/test/.hermes/profiles/qa-lead",
        };
        return { body: { ok: true, name: "qa-lead", path: profiles[0].path } };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    const adapter = await importAdapter(makeHome(), url, "profile-token");

    await callGateway(adapter, "agents.list");
    await callGateway(adapter, "sessions.patch", {
      key: "agent:coder:main",
      model: "profile-model",
    });
    const cron = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "Profile cron",
      agentId: "coder",
      sessionKey: "agent:coder:main",
    });

    await callGateway(adapter, "agents.update", {
      agentId: "coder",
      role: "Reviews code",
    });
    const renamed = await callGateway<{
      ok: boolean;
      previousAgentId?: string;
      agentId?: string;
      newAgentId?: string;
    }>(adapter, "agents.update", {
      agentId: "coder",
      name: "QA Lead",
    });

    expect(renamed).toEqual({
      ok: true,
      removedBindings: 0,
      previousAgentId: "coder",
      agentId: "qa-lead",
      newAgentId: "qa-lead",
    });

    const sessions = await callGateway<{ sessions: Array<{ key: string; model?: string }> }>(
      adapter,
      "sessions.list"
    );
    expect(sessions.sessions).toContainEqual(
      expect.objectContaining({ key: "agent:qa-lead:main", model: "profile-model" })
    );
    expect(sessions.sessions.map((session) => session.key)).not.toContain("agent:coder:main");

    const cronList = await callGateway<{
      jobs: Array<{ id: string; agentId: string; sessionKey: string }>;
    }>(adapter, "cron.list");
    expect(cronList.jobs).toContainEqual(
      expect.objectContaining({
        id: cron.id,
        agentId: "qa-lead",
        sessionKey: "agent:qa-lead:main",
      })
    );
  });

  it("rejects deletion of the default Hermes profile", async () => {
    const { url } = await startFakeProfiles((request) => {
      if (request.method === "GET" && request.url === "/api/profiles") {
        return { body: { profiles: [{ name: "default", is_default: true }] } };
      }
      return { status: 404, body: { detail: "not found" } };
    });
    const adapter = await importAdapter(makeHome(), url, "profile-token");

    const response = await callGatewayRaw(adapter, "agents.delete", { agentId: "hermes" });
    expect(response).toMatchObject({
      type: "res",
      ok: false,
      error: {
        code: "invalid_request",
        message: "Cannot delete the default Hermes profile.",
      },
    });
  });

  it("falls back to the adapter-owned registry when profile listing is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { url } = await startFakeProfiles(() => ({
      status: 503,
      body: { detail: "dashboard offline" },
    }));
    const adapter = await importAdapter(makeHome(), url, "profile-token");

    const listed = await callGateway<{ agents: Array<{ id: string; metadata?: unknown }> }>(
      adapter,
      "agents.list"
    );

    expect(listed.agents).toContainEqual(expect.objectContaining({ id: "hermes" }));
    expect(listed.agents[0]?.metadata).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[hermes-adapter] Hermes profile API unavailable; using compat fallback:",
      expect.stringContaining("dashboard offline")
    );
  });
});
