import { describe, expect, it } from "vitest";

import { formatSkillOperationError } from "@/lib/skills/error-messages";

describe("skills error messages", () => {
  it("adds operation context and diagnostics for frontend display", () => {
    const message = formatSkillOperationError(new Error("workspaceDir is required."), {
      action: "Failed to install and enable task-manager",
      fallback: "Failed to install and enable the skill.",
      step: "validating workspace paths",
      skillKey: "task-manager",
      agentId: "main",
      diagnostics: {
        workspaceDir: undefined,
        managedSkillsDir: "",
        skillCount: 0,
      },
    });

    expect(message).toContain(
      "Failed to install and enable task-manager while validating workspace paths: workspaceDir is required."
    );
    expect(message).toContain("skillKey=task-manager");
    expect(message).toContain("agentId=main");
    expect(message).toContain("workspaceDir=(missing)");
    expect(message).toContain("managedSkillsDir=(empty)");
    expect(message).toContain("skillCount=0");
  });
});
