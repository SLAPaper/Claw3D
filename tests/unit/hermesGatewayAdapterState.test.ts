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

const originalHome = process.env.HOME;
const originalStateDir = process.env.HERMES_ADAPTER_STATE_DIR;
const tempHomes: string[] = [];
const tempWorkspaces: string[] = [];

const sendEvent = () => {};

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-state-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-state-workspace-"));
  tempWorkspaces.push(workspace);
  return workspace;
};

const importAdapter = async (
  home: string,
  stateDir?: string
): Promise<HermesAdapterModule> => {
  vi.resetModules();
  process.env.HOME = home;
  if (stateDir) {
    process.env.HERMES_ADAPTER_STATE_DIR = stateDir;
  } else {
    delete process.env.HERMES_ADAPTER_STATE_DIR;
  }
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

const writeTaskManagerSkill = (workspace: string) => {
  const skillDir = path.join(workspace, "skills", "task-manager");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: task-manager",
      "description: Capture tasks.",
      'metadata: {"openclaw":{"skillKey":"task-manager"}}',
      "---",
      "",
      "# Task Manager",
      "",
    ].join("\n"),
    "utf8"
  );
};

afterEach(() => {
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

  while (tempWorkspaces.length > 0) {
    fs.rmSync(tempWorkspaces.pop()!, { recursive: true, force: true });
  }
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe("hermes-gateway-adapter durable state", () => {
  it("persists created and updated agents across adapter reload", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);
    const workspace = makeWorkspace();
    const updatedWorkspace = makeWorkspace();

    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Persistent Agent",
      workspace,
    });
    await callGateway(adapter, "agents.update", {
      agentId: created.agentId,
      name: "Persistent Agent Updated",
      role: "Planner",
      workspace: updatedWorkspace,
    });

    expect(
      fs.existsSync(path.join(home, ".hermes", "claw3d-adapter-state.json"))
    ).toBe(true);

    adapter = await importAdapter(home);
    const listed = await callGateway<{
      agents: Array<{ id: string; name: string; role?: string; workspace: string }>;
    }>(adapter, "agents.list");

    expect(listed.agents).toContainEqual(
      expect.objectContaining({
        id: created.agentId,
        name: "Persistent Agent Updated",
        role: "Planner",
        workspace: updatedWorkspace,
      })
    );
  });

  it("honors HERMES_ADAPTER_STATE_DIR for the adapter state file", async () => {
    const home = makeHome();
    const stateDir = path.join(home, "custom-state");
    const adapter = await importAdapter(home, stateDir);

    await callGateway(adapter, "agents.create", {
      name: "Custom State Agent",
      workspace: makeWorkspace(),
    });

    expect(
      fs.existsSync(path.join(stateDir, "claw3d-adapter-state.json"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, ".hermes", "claw3d-adapter-state.json"))
    ).toBe(false);
  });

  it("persists session settings skill toggles and cron jobs across adapter reload", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);
    const workspace = makeWorkspace();
    writeTaskManagerSkill(workspace);

    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Stateful Operator",
      workspace,
    });
    const sessionKey = `agent:${created.agentId}:main`;

    await callGateway(adapter, "sessions.patch", {
      key: sessionKey,
      model: "persisted-model",
      thinkingLevel: "high",
    });
    await callGateway(adapter, "skills.update", {
      skillKey: "task-manager",
      enabled: false,
    });
    const addedJob = await callGateway<{ id: string }>(adapter, "cron.add", {
      name: "Daily Sync",
      agentId: created.agentId,
      sessionKey,
      schedule: { kind: "every", everyMs: 3600000 },
    });
    await callGateway(adapter, "cron.patch", {
      id: addedJob.id,
      enabled: false,
      schedule: { kind: "every", everyMs: 1234 },
      payload: { kind: "systemEvent", text: "persisted tick" },
    });

    adapter = await importAdapter(home);

    const sessions = await callGateway<{
      sessions: Array<{ key: string; model: string }>;
    }>(adapter, "sessions.list");
    expect(sessions.sessions).toContainEqual(
      expect.objectContaining({ key: sessionKey, model: "persisted-model" })
    );

    const skillStatus = await callGateway<{
      skills: Array<{ skillKey: string; disabled: boolean; eligible: boolean }>;
    }>(adapter, "skills.status", { agentId: created.agentId });
    expect(skillStatus.skills).toContainEqual(
      expect.objectContaining({
        skillKey: "task-manager",
        disabled: true,
        eligible: false,
      })
    );

    const cron = await callGateway<{
      jobs: Array<{
        id: string;
        enabled: boolean;
        schedule: { kind: string; everyMs: number };
        payload: { kind: string; text: string };
      }>;
    }>(adapter, "cron.list");
    expect(cron.jobs).toContainEqual(
      expect.objectContaining({
        id: addedJob.id,
        enabled: false,
        schedule: { kind: "every", everyMs: 1234 },
        payload: { kind: "systemEvent", text: "persisted tick" },
      })
    );
  });

  it("persists config set and patch with hash protection", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);

    const removedAgent = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Config Removed Agent",
      workspace: makeWorkspace(),
    });

    const firstConfig = await callGateway<{
      config: Record<string, unknown>;
      hash: string;
      exists: boolean;
      path: string;
    }>(adapter, "config.get");
    expect(firstConfig.exists).toBe(true);
    expect(path.normalize(firstConfig.path)).toBe(
      path.join(home, ".hermes", "config.json")
    );

    const fullConfig = {
      gateway: { reload: { mode: "hybrid", strategy: "keep" } },
      agents: { list: [] },
      custom: { alpha: 1 },
      arrayValue: ["initial"],
    };

    const setResult = await callGateway<{ hash: string }>(adapter, "config.set", {
      raw: JSON.stringify(fullConfig),
      baseHash: firstConfig.hash,
    });
    expect(setResult.hash).not.toBe(firstConfig.hash);

    const afterSetAgents = await callGateway<{
      agents: Array<{ id: string }>;
    }>(adapter, "agents.list");
    expect(afterSetAgents.agents.map((agent) => agent.id)).not.toContain(
      removedAgent.agentId
    );

    adapter = await importAdapter(home);
    const afterReload = await callGateway<{
      config: typeof fullConfig;
      hash: string;
    }>(adapter, "config.get");
    expect(afterReload.config).toEqual(fullConfig);

    const patchResult = await callGateway<{ hash: string }>(adapter, "config.patch", {
      raw: JSON.stringify({
        gateway: { reload: { mode: "hot" } },
        custom: { beta: 2 },
        arrayValue: ["patched"],
      }),
      baseHash: afterReload.hash,
    });
    expect(patchResult.hash).not.toBe(afterReload.hash);

    const afterPatch = await callGateway<{
      config: {
        gateway: { reload: { mode: string; strategy: string } };
        custom: { alpha: number; beta: number };
        arrayValue: string[];
      };
    }>(adapter, "config.get");
    expect(afterPatch.config).toEqual({
      gateway: { reload: { mode: "hot", strategy: "keep" } },
      agents: { list: [] },
      custom: { alpha: 1, beta: 2 },
      arrayValue: ["patched"],
    });

    const stale = await callGatewayRaw(adapter, "config.patch", {
      raw: JSON.stringify({ custom: { gamma: 3 } }),
      baseHash: afterReload.hash,
    });
    expect(stale).toMatchObject({
      type: "res",
      ok: false,
      error: {
        message: "config changed since last load; re-run config.get and retry",
      },
    });
  });
});
