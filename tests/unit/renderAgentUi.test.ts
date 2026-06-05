import { describe, expect, it } from "vitest";

import {
  areRenderAgentUiSnapshotsEqual,
  type RenderAgentUiSnapshot,
} from "@/features/retro-office/renderAgentUi";

describe("render agent UI snapshots", () => {
  it("treats structurally identical snapshots as equal", () => {
    const current: Record<string, RenderAgentUiSnapshot> = {
      "agent-1": { state: "idle", status: "idle" },
      "agent-2": { state: "working", status: "running" },
    };
    const next: Record<string, RenderAgentUiSnapshot> = {
      "agent-1": { state: "idle", status: "idle" },
      "agent-2": { state: "working", status: "running" },
    };

    expect(areRenderAgentUiSnapshotsEqual(current, next)).toBe(true);
  });

  it("detects changed, added, or removed snapshots", () => {
    const current: Record<string, RenderAgentUiSnapshot> = {
      "agent-1": { state: "idle", status: "idle" },
    };

    expect(
      areRenderAgentUiSnapshotsEqual(current, {
        "agent-1": { state: "working", status: "running" },
      }),
    ).toBe(false);
    expect(
      areRenderAgentUiSnapshotsEqual(current, {
        "agent-1": { state: "idle", status: "idle" },
        "agent-2": { state: "idle", status: "idle" },
      }),
    ).toBe(false);
    expect(areRenderAgentUiSnapshotsEqual(current, {})).toBe(false);
  });
});
