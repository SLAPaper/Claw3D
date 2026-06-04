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
const bootstrapFileNames = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
] as const;

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-workspace-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspacePath = () => {
  const workspace = path.join(
    os.tmpdir(),
    `hermes-workspace-files-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  tempWorkspaces.push(workspace);
  return workspace;
};

const importAdapter = async (home: string): Promise<HermesAdapterModule> => {
  vi.resetModules();
  process.env.HOME = home;
  delete process.env.HERMES_ADAPTER_STATE_DIR;
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

describe("hermes-gateway-adapter workspace files", () => {
  it("creates the agent workspace and bootstraps the seven brain files", async () => {
    const home = makeHome();
    const adapter = await importAdapter(home);
    const workspace = makeWorkspacePath();

    const created = await callGateway<{ agentId: string; workspace: string }>(adapter, "agents.create", {
      name: "Workspace Brain",
      workspace,
    });

    expect(created.workspace).toBe(workspace);
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    for (const name of bootstrapFileNames) {
      expect(fs.existsSync(path.join(workspace, name))).toBe(true);
    }
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
      "- Name: Workspace Brain"
    );

    const listed = await callGateway<{
      workspace: string;
      files: Array<{ name: string; missing: boolean; path: string; size: number }>;
    }>(adapter, "agents.files.list", { agentId: created.agentId });

    expect(listed.workspace).toBe(workspace);
    expect(listed.files.map((file) => file.name)).toEqual([...bootstrapFileNames].sort());
    expect(listed.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "IDENTITY.md",
          missing: false,
          path: path.join(workspace, "IDENTITY.md"),
        }),
      ])
    );
  });

  it("reads writes and lists agent files from the filesystem across adapter reload", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);
    const workspace = makeWorkspacePath();

    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Durable Files",
      workspace,
    });

    await callGateway(adapter, "agents.files.set", {
      agentId: created.agentId,
      name: "SOUL.md",
      content: "# SOUL.md\n\nA persisted soul.\n",
    });
    await callGateway(adapter, "agents.files.set", {
      agentId: created.agentId,
      name: "notes/todo.md",
      content: "- remember workspace files\n",
    });

    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf8")).toBe(
      "# SOUL.md\n\nA persisted soul.\n"
    );

    adapter = await importAdapter(home);

    const file = await callGateway<{
      workspace: string;
      file: { missing?: boolean; content?: string; path?: string };
    }>(adapter, "agents.files.get", {
      agentId: created.agentId,
      name: "SOUL.md",
    });
    expect(file).toEqual({
      workspace,
      file: {
        content: "# SOUL.md\n\nA persisted soul.\n",
        path: path.join(workspace, "SOUL.md"),
      },
    });

    const listed = await callGateway<{
      files: Array<{ name: string; size: number }>;
    }>(adapter, "agents.files.list", { agentId: created.agentId });

    expect(listed.files.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["SOUL.md", "notes/todo.md"])
    );
  });

  it("rejects file paths that escape the agent workspace", async () => {
    const home = makeHome();
    const adapter = await importAdapter(home);
    const workspace = makeWorkspacePath();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Path Guard",
      workspace,
    });

    const invalidNames = [
      "../evil.txt",
      "skills/../evil.txt",
      path.resolve(workspace, "absolute.txt"),
      "C:/evil.txt",
      "C:\\evil.txt",
    ];

    for (const name of invalidNames) {
      const response = await callGatewayRaw(adapter, "agents.files.set", {
        agentId: created.agentId,
        name,
        content: "bad",
      });
      expect(response).toMatchObject({
        type: "res",
        ok: false,
        error: { code: "invalid_request" },
      });
    }

    expect(fs.existsSync(path.join(path.dirname(workspace), "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "skills", "evil.txt"))).toBe(false);
  });

  it("keeps IDENTITY.md available for identity recovery across adapter reload", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);
    const workspace = makeWorkspacePath();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Temporary Runtime Name",
      workspace,
    });

    const identity = "# IDENTITY.md - Who Am I?\n\n- Name: GLaDOS\n";
    await callGateway(adapter, "agents.files.set", {
      agentId: created.agentId,
      name: "IDENTITY.md",
      content: identity,
    });

    adapter = await importAdapter(home);
    const file = await callGateway<{
      workspace: string;
      file: { missing?: boolean; content?: string; path?: string };
    }>(adapter, "agents.files.get", {
      agentId: created.agentId,
      name: "IDENTITY.md",
    });

    expect(file).toEqual({
      workspace,
      file: {
        content: identity,
        path: path.join(workspace, "IDENTITY.md"),
      },
    });
  });
});
