import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import { useUsageAnalytics } from "@/features/office/hooks/useUsageAnalytics";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { defaultStudioAnalyticsPreference } from "@/lib/studio/settings";

const createAgent = (): AgentState => ({
  agentId: "agent-1",
  name: "Agent One",
  sessionKey: "agent:agent-1:main",
  status: "idle",
  sessionCreated: true,
  awaitingUserInput: false,
  hasUnseenActivity: false,
  outputLines: [],
  lastResult: null,
  lastDiff: null,
  runId: null,
  runStartedAt: null,
  streamText: null,
  thinkingTrace: null,
  latestOverride: null,
  latestOverrideKind: null,
  lastAssistantMessageAt: null,
  lastActivityAt: null,
  latestPreview: null,
  lastUserMessage: null,
  draft: "",
  sessionSettingsSynced: true,
  historyLoadedAt: null,
  historyFetchLimit: null,
  historyFetchedCount: null,
  historyMaybeTruncated: false,
  toolCallingEnabled: true,
  showThinkingTraces: true,
  model: "hermes-test-model",
  thinkingLevel: "medium",
  avatarSeed: "seed-1",
  avatarUrl: null,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUsageAnalytics", () => {
  it("preserves Hermes usage metadata while normalizing session and cost rows", async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "sessions.usage") {
          return {
            sessions: [
              {
                key: "agent:agent-1:main",
                agentId: "agent-1",
                model: "hermes-test-model",
                modelProvider: "hermes",
                updatedAt: 1000,
                usage: {
                  totalTokens: 12,
                  totalCost: 0,
                  messageCounts: { total: 2, user: 1, assistant: 1 },
                  modelUsage: [
                    {
                      provider: "hermes",
                      model: "hermes-test-model",
                      count: 1,
                      totals: { totalTokens: 12, totalCost: 0 },
                    },
                  ],
                  dailyBreakdown: [{ date: "2026-06-05", tokens: 12, cost: 0 }],
                  dailyMessageCounts: [{ date: "2026-06-05", total: 2 }],
                },
              },
            ],
            totals: { totalTokens: 12, totalCost: 0 },
            metadata: {
              runtime: "hermes",
              tokenSource: "estimated",
              costSource: "none",
              legacyDateSource: "message-created-at",
            },
          };
        }
        return {
          daily: [{ date: "2026-06-05", totalTokens: 12, totalCost: 0 }],
          metadata: {
            runtime: "hermes",
            tokenSource: "estimated",
            costSource: "none",
            legacyDateSource: "message-created-at",
          },
        };
      }),
    } as unknown as GatewayClient;

    const { result } = renderHook(() =>
      useUsageAnalytics({
        client,
        status: "connected",
        agents: [createAgent()],
        startDate: "2026-06-05",
        endDate: "2026-06-05",
        budgets: defaultStudioAnalyticsPreference().budgets,
      })
    );

    await waitFor(() => expect(result.current.lastRefreshedAt).not.toBeNull());

    expect(result.current.metadata).toMatchObject({
      runtime: "hermes",
      tokenSource: "estimated",
      costSource: "none",
    });
    expect(result.current.sessions).toContainEqual(
      expect.objectContaining({
        key: "agent:agent-1:main",
        agentName: "Agent One",
      })
    );
    expect(result.current.totals.totalTokens).toBe(12);
    expect(result.current.costDaily).toContainEqual(
      expect.objectContaining({ date: "2026-06-05", totalTokens: 12, totalCost: 0 })
    );
  });
});
