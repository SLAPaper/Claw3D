import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import { AnalyticsPanel } from "@/features/office/components/panels/AnalyticsPanel";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import type { StudioSettingsCoordinator } from "@/lib/studio/coordinator";

const mockViewModel = vi.hoisted(() => ({
  value: null as unknown,
}));

vi.mock("@/features/office/hooks/useOfficeUsageAnalyticsViewModel", () => ({
  useOfficeUsageAnalyticsViewModel: () => mockViewModel.value,
}));

vi.mock("@/features/office/hooks/useApprovalMetrics", () => ({
  useApprovalMetrics: () => ({
    totals: { requestedCount: 0 },
    byAgent: new Map(),
  }),
}));

vi.mock("@/features/office/hooks/usePerformanceAnalytics", () => ({
  usePerformanceAnalytics: () => ({
    fleet: {
      successRate: null,
      avgRuntimeMs: null,
      totalToolCalls: 0,
      completedRuns: 0,
      interventionRate: null,
    },
    rows: [],
  }),
}));

const emptyTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  durationMs: 0,
};

const createUsage = (metadata: Record<string, unknown>) => ({
  loading: false,
  error: null,
  refresh: vi.fn(),
  sessions: [],
  costDaily: [],
  lastRefreshedAt: null,
  totals: { ...emptyTotals },
  metadata,
  aggregates: {
    totals: { ...emptyTotals },
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byAgent: [],
    daily: [],
  },
  budgetAlerts: [],
});

const setViewModel = (metadata: Record<string, unknown>) => {
  mockViewModel.value = {
    startDate: "2026-06-05",
    setStartDate: vi.fn(),
    endDate: "2026-06-05",
    setEndDate: vi.fn(),
    budgets: {
      dailySpendLimitUsd: null,
      monthlySpendLimitUsd: null,
      perAgentSoftLimitUsd: null,
      alertThresholdPct: 80,
    },
    settingsLoaded: true,
    usage: createUsage(metadata),
    updateBudget: vi.fn(),
  };
};

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

const renderPanel = () =>
  render(
    createElement(AnalyticsPanel, {
      client: {} as GatewayClient,
      status: "connected",
      agents: [createAgent()],
      runLog: [],
      gatewayUrl: "ws://localhost:18789",
      settingsCoordinator: {} as StudioSettingsCoordinator,
      onSelectAgent: vi.fn(),
    })
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AnalyticsPanel", () => {
  it("shows a Hermes estimated-token notice", () => {
    setViewModel({
      runtime: "hermes",
      tokenSource: "estimated",
      costSource: "none",
    });

    renderPanel();

    expect(screen.getByText(/Hermes token counts are estimated/i)).toBeInTheDocument();
    expect(screen.getByText(/Cost values stay at \$0\.00/i)).toBeInTheDocument();
  });

  it("does not show the Hermes estimate notice for metadata-backed usage", () => {
    setViewModel({
      runtime: "hermes",
      tokenSource: "metadata",
      costSource: "metadata",
    });

    renderPanel();

    expect(screen.queryByText(/Hermes token counts are estimated/i)).not.toBeInTheDocument();
  });
});
