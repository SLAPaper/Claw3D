import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
process.env.HOME = hermesHome;
const { handleMethod } = await import("../../server/hermes-gateway-adapter.js");

const tempWorkspaces: string[] = [];

const sendEvent = () => {};

const callGateway = async <Payload = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<Payload> => {
  const response = await handleMethod(method, params, method, sendEvent);
  expect(response).toMatchObject({ type: "res", ok: true });
  return (response as { payload: Payload }).payload;
};

const makeWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skills-"));
  tempWorkspaces.push(workspace);
  return workspace;
};

const createAgentWithWorkspace = async (workspace: string) => {
  const created = await callGateway<{ agentId: string }>("agents.create", {
    name: `Skill Target ${Date.now()}`,
    workspace,
  });
  return created.agentId;
};

const buildInstallerMessage = (
  files: Array<{ relativePath: string; content: string }>
) =>
  [
    "Create these exact skill files inside the current workspace.",
    "You must use the file tools and write the files exactly as provided.",
    "Do not modify filenames, frontmatter, spacing, or content.",
    "Create parent directories if they do not exist.",
    "After writing the files, verify they exist and then reply only with: INSTALLED",
    "",
    "Files:",
    files
      .map(
        (file) =>
          `- path: ${JSON.stringify(file.relativePath)}\n  content: ${JSON.stringify(file.content)}`
      )
      .join("\n"),
  ].join("\n");

const skillDoc = [
  "---",
  "name: task-manager",
  "description: Capture tasks.",
  'metadata: {"openclaw":{"skillKey":"task-manager"}}',
  "---",
  "",
  "# Task Manager",
  "",
].join("\n");

const installTaskManager = async (agentId: string) => {
  const sendResult = await callGateway<{ runId: string }>("chat.send", {
    sessionKey: `agent:${agentId}:main`,
    message: buildInstallerMessage([
      {
        relativePath: "skills/task-manager/SKILL.md",
        content: skillDoc,
      },
      {
        relativePath: "skills/task-manager/tasks.example.json",
        content: "[]\n",
      },
    ]),
    deliver: false,
    idempotencyKey: `skill-install:task-manager:${Date.now()}`,
  });

  await callGateway("agent.wait", { runId: sendResult.runId, timeoutMs: 1000 });
};

afterEach(() => {
  while (tempWorkspaces.length > 0) {
    const workspace = tempWorkspaces.pop();
    if (!workspace) continue;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(hermesHome, { recursive: true, force: true });
});

describe("hermes-gateway-adapter skills", () => {
  it("reports workspace and managed skill directories for a Hermes agent", async () => {
    const workspace = makeWorkspace();
    const agentId = await createAgentWithWorkspace(workspace);

    const report = await callGateway<{
      workspaceDir: string;
      managedSkillsDir: string;
      skills: unknown[];
    }>("skills.status", { agentId });

    expect(report.workspaceDir).toBe(workspace);
    expect(report.managedSkillsDir).toMatch(/[\\/]\.hermes[\\/]skills$/);
    expect(report.skills).toEqual([]);
  });

  it("lists agent files without falling through to the unhandled method logger", async () => {
    const workspace = makeWorkspace();
    const agentId = await createAgentWithWorkspace(workspace);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const report = await callGateway<{ workspace: string; files: Array<{ name: string }> }>(
        "agents.files.list",
        { agentId }
      );

      expect(report.workspace).toBe(workspace);
      expect(report.files.map((file) => file.name)).toEqual(
        expect.arrayContaining([
          "AGENTS.md",
          "SOUL.md",
          "IDENTITY.md",
          "USER.md",
          "TOOLS.md",
          "HEARTBEAT.md",
          "MEMORY.md",
        ])
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Unhandled method: agents.files.list")
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("writes packaged skill files from installer chat and reports the installed skill", async () => {
    const workspace = makeWorkspace();
    const agentId = await createAgentWithWorkspace(workspace);

    await installTaskManager(agentId);

    expect(
      fs.readFileSync(
        path.join(workspace, "skills", "task-manager", "SKILL.md"),
        "utf8"
      )
    ).toBe(skillDoc);
    expect(
      fs.readFileSync(
        path.join(workspace, "skills", "task-manager", "tasks.example.json"),
        "utf8"
      )
    ).toBe("[]\n");

    const report = await callGateway<{
      skills: Array<{
        name: string;
        description: string;
        source: string;
        bundled: boolean;
        filePath: string;
        baseDir: string;
        skillKey: string;
        always: boolean;
        disabled: boolean;
        blockedByAllowlist: boolean;
        eligible: boolean;
        requirements: Record<string, string[]>;
        missing: Record<string, string[]>;
        configChecks: unknown[];
        install: unknown[];
      }>;
    }>("skills.status", { agentId });
    const skill = report.skills.find((entry) => entry.skillKey === "task-manager");

    expect(skill).toMatchObject({
      name: "task-manager",
      description: "Capture tasks.",
      source: "openclaw-workspace",
      bundled: false,
      filePath: path.join(workspace, "skills", "task-manager", "SKILL.md"),
      baseDir: path.join(workspace, "skills", "task-manager"),
      skillKey: "task-manager",
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    });
  });

  it("rejects installer file paths that escape the skills directory", async () => {
    const workspace = makeWorkspace();
    const agentId = await createAgentWithWorkspace(workspace);

    await expect(
      handleMethod(
        "chat.send",
        {
          sessionKey: `agent:${agentId}:main`,
          message: buildInstallerMessage([
            {
              relativePath: "skills/task-manager/../evil.txt",
              content: "bad",
            },
          ]),
          deliver: false,
          idempotencyKey: `skill-install:task-manager:${Date.now()}`,
        },
        "chat.send",
        sendEvent
      )
    ).rejects.toThrow(/invalid installer file path/i);

    expect(fs.existsSync(path.join(workspace, "skills", "evil.txt"))).toBe(false);
  });

  it("updates enabled state through skills.update", async () => {
    const workspace = makeWorkspace();
    const agentId = await createAgentWithWorkspace(workspace);
    await installTaskManager(agentId);

    await callGateway("skills.update", { skillKey: "task-manager", enabled: false });
    let report = await callGateway<{
      skills: Array<{ skillKey: string; disabled: boolean; eligible: boolean }>;
    }>("skills.status", { agentId });
    let skill = report.skills.find((entry) => entry.skillKey === "task-manager");
    expect(skill).toMatchObject({ disabled: true, eligible: false });

    await callGateway("skills.update", { skillKey: "task-manager", enabled: true });
    report = await callGateway<{
      skills: Array<{ skillKey: string; disabled: boolean; eligible: boolean }>;
    }>("skills.status", { agentId });
    skill = report.skills.find((entry) => entry.skillKey === "task-manager");
    expect(skill).toMatchObject({ disabled: false, eligible: true });
  });
});
