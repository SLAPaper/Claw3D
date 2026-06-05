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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skill-install-home-"));
  tempHomes.push(home);
  return home;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skill-install-workspace-"));
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

describe("hermes-gateway-adapter packaged skill install", () => {
  it("installs packaged workspace skill files and reports them in skills.status", async () => {
    const adapter = await importAdapter(makeHome());
    const workspace = makeWorkspace();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Packaged Skill Target",
      workspace,
    });

    const result = await callGateway<{
      installed: boolean;
      installedPath: string;
      source: string;
      skillKey: string;
      workspaceDir: string;
      filesWritten: number;
    }>(adapter, "skills.install", {
      packageId: "task-manager",
      source: "openclaw-workspace",
      agentId: created.agentId,
      workspaceDir: workspace,
    });

    expect(result).toEqual({
      installed: true,
      installedPath: path.join(workspace, "skills", "task-manager"),
      source: "openclaw-workspace",
      skillKey: "task-manager",
      workspaceDir: workspace,
      filesWritten: 2,
    });
    const skillFile = path.join(workspace, "skills", "task-manager", "SKILL.md");
    expect(fs.readFileSync(skillFile, "utf8")).toContain(
      'metadata: {"openclaw":{"skillKey":"task-manager"}}'
    );
    expect(fs.existsSync(path.join(workspace, "skills", "task-manager", "tasks.example.json"))).toBe(true);

    const status = await callGateway<{
      skills: Array<{ skillKey: string; source: string; filePath: string }>;
    }>(adapter, "skills.status", { agentId: created.agentId });
    expect(status.skills).toContainEqual(
      expect.objectContaining({
        skillKey: "task-manager",
        source: "openclaw-workspace",
        filePath: skillFile,
      })
    );
  });

  it("rejects unsupported install requests without writing files", async () => {
    const adapter = await importAdapter(makeHome());
    const workspace = makeWorkspace();
    const created = await callGateway<{ agentId: string }>(adapter, "agents.create", {
      name: "Unsupported Skill Target",
      workspace,
    });

    const dependencyInstall = await callGatewayRaw(adapter, "skills.install", {
      name: "browser",
      installId: "install-browser",
    });
    expect(dependencyInstall).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "not_supported" },
    });

    const unknownPackage = await callGatewayRaw(adapter, "skills.install", {
      packageId: "missing-package",
      source: "openclaw-workspace",
      agentId: created.agentId,
      workspaceDir: workspace,
    });
    expect(unknownPackage).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "not_found" },
    });

    const unsupportedSource = await callGatewayRaw(adapter, "skills.install", {
      packageId: "task-manager",
      source: "openclaw-managed",
      agentId: created.agentId,
      workspaceDir: workspace,
    });
    expect(unsupportedSource).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "not_supported" },
    });

    expect(fs.existsSync(path.join(workspace, "skills", "task-manager"))).toBe(false);
  });
});
