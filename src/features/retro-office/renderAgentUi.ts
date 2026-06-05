import type { RenderAgent } from "@/features/retro-office/core/types";

export type RenderAgentUiSnapshot = Pick<RenderAgent, "state" | "status">;

export const areRenderAgentUiSnapshotsEqual = (
  current: Record<string, RenderAgentUiSnapshot>,
  next: Record<string, RenderAgentUiSnapshot>,
): boolean => {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return false;

  for (const key of currentKeys) {
    const currentValue = current[key];
    const nextValue = next[key];
    if (!currentValue || !nextValue) return false;
    if (
      currentValue.state !== nextValue.state ||
      currentValue.status !== nextValue.status
    ) {
      return false;
    }
  }

  return true;
};
