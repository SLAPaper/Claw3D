"use strict";

const fs = require("fs");

const EMPTY_TOTALS = {
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

function createUsage(ctx) {
  const { config, state, utils } = ctx;
  const { cloneJson, isPlainObject, resolveAgentIdFromSessionKey } = utils;

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function firstFinite(...values) {
    for (const value of values) {
      const number = finiteNumber(value);
      if (number !== null) return number;
    }
    return null;
  }

  function addTotals(left, right) {
    const next = { ...EMPTY_TOTALS };
    for (const key of Object.keys(next)) {
      next[key] = (finiteNumber(left?.[key]) || 0) + (finiteNumber(right?.[key]) || 0);
    }
    return next;
  }

  function emptyMessageCounts() {
    return { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
  }

  function addMessageCounts(left, right) {
    return {
      total: left.total + right.total,
      user: left.user + right.user,
      assistant: left.assistant + right.assistant,
      toolCalls: left.toolCalls + right.toolCalls,
      toolResults: left.toolResults + right.toolResults,
      errors: left.errors + right.errors,
    };
  }

  function normalizeDateInput(value, fallbackMs) {
    if (typeof value !== "string" || !value.trim()) return fallbackMs;
    const parsed = Date.parse(`${value.trim()}T00:00:00.000Z`);
    return Number.isFinite(parsed) ? parsed : fallbackMs;
  }

  function parseDateRange(params = {}) {
    const startMs = normalizeDateInput(params.startDate, 0);
    const endStartMs = normalizeDateInput(params.endDate, Date.now());
    return {
      startMs,
      endMs: endStartMs + 86_400_000 - 1,
    };
  }

  function dateFromMs(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function getHistoryFileMtimeMs() {
    try {
      const stat = fs.statSync(config.HISTORY_FILE);
      if (Number.isFinite(stat.mtimeMs)) return stat.mtimeMs;
    } catch {
      // The history file is created lazily; in-memory legacy entries use now.
    }
    return Date.now();
  }

  function estimateTextTokens(content) {
    const text = typeof content === "string" ? content : String(content || "");
    if (!text) return 0;
    let ascii = 0;
    let nonAscii = 0;
    for (const char of text) {
      if (char.charCodeAt(0) <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
    return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
  }

  function normalizeStoredTotals(raw) {
    if (!isPlainObject(raw)) return null;
    const source = isPlainObject(raw.totals) ? raw.totals : raw;
    const totals = {
      input: firstFinite(source.input, source.prompt_tokens, source.input_tokens) || 0,
      output: firstFinite(source.output, source.completion_tokens, source.output_tokens) || 0,
      cacheRead: firstFinite(
        source.cacheRead,
        source.cache_read,
        source.cache_read_input_tokens,
        source.prompt_tokens_details?.cached_tokens,
        source.input_token_details?.cache_read
      ) || 0,
      cacheWrite: firstFinite(
        source.cacheWrite,
        source.cache_write,
        source.cache_creation_input_tokens,
        source.input_token_details?.cache_write
      ) || 0,
      totalTokens: firstFinite(source.totalTokens, source.total_tokens) || 0,
      inputCost: firstFinite(source.inputCost, source.input_cost) || 0,
      outputCost: firstFinite(source.outputCost, source.output_cost) || 0,
      cacheReadCost: firstFinite(source.cacheReadCost, source.cache_read_cost) || 0,
      cacheWriteCost: firstFinite(source.cacheWriteCost, source.cache_write_cost) || 0,
      totalCost: firstFinite(source.totalCost, source.total_cost, source.cost) || 0,
      durationMs: firstFinite(source.durationMs) || 0,
    };
    if (!totals.totalTokens) {
      totals.totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    }
    if (!totals.totalCost) {
      totals.totalCost =
        totals.inputCost + totals.outputCost + totals.cacheReadCost + totals.cacheWriteCost;
    }
    const hasTokenMetadata = typeof raw.tokenSource === "string"
      ? raw.tokenSource === "metadata"
      : firstFinite(source.totalTokens, source.total_tokens, source.prompt_tokens, source.input_tokens, source.completion_tokens, source.output_tokens) !== null;
    const hasCostMetadata = typeof raw.costSource === "string"
      ? raw.costSource === "metadata"
      : firstFinite(
          source.totalCost,
          source.total_cost,
          source.cost,
          source.inputCost,
          source.input_cost,
          source.outputCost,
          source.output_cost,
          source.cacheReadCost,
          source.cache_read_cost,
          source.cacheWriteCost,
          source.cache_write_cost
        ) !== null;
    if (!hasTokenMetadata && !hasCostMetadata && totals.totalTokens === 0 && totals.totalCost === 0) {
      return null;
    }
    return {
      totals,
      tokenSource: hasTokenMetadata ? "metadata" : "none",
      costSource: hasCostMetadata ? "metadata" : "none",
    };
  }

  function mergeUsageRecords(left, right) {
    if (!left) return right ? cloneJson(right) : null;
    if (!right) return cloneJson(left);
    return {
      totals: addTotals(left.totals, right.totals),
      tokenSource: mergeSource(left.tokenSource, right.tokenSource, "none"),
      costSource: mergeSource(left.costSource, right.costSource, "none"),
    };
  }

  function mergeSource(left, right, emptyValue) {
    const sources = new Set([left, right].filter((value) => value && value !== emptyValue));
    if (sources.size === 0) return emptyValue;
    if (sources.size === 1) return [...sources][0];
    return "mixed";
  }

  function createHistoryMessage(input) {
    const message = {
      role: input.role,
      content: input.content,
    };
    if (finiteNumber(input.createdAtMs) !== null) message.createdAtMs = input.createdAtMs;
    if (typeof input.runId === "string" && input.runId) message.runId = input.runId;
    if (typeof input.model === "string" && input.model) message.model = input.model;
    if (typeof input.modelProvider === "string" && input.modelProvider) {
      message.modelProvider = input.modelProvider;
    }
    if (finiteNumber(input.durationMs) !== null) message.durationMs = input.durationMs;
    const usage = normalizeStoredTotals(input.usage);
    if (usage) {
      message.usage = {
        ...usage.totals,
        tokenSource: usage.tokenSource,
        costSource: usage.costSource,
      };
    }
    return message;
  }

  function messageTimestampMs(message, legacyMtimeMs) {
    const createdAtMs = finiteNumber(message?.createdAtMs);
    if (createdAtMs !== null) return { ms: createdAtMs, source: "message-created-at" };
    if (typeof message?.createdAt === "string") {
      const parsed = Date.parse(message.createdAt);
      if (Number.isFinite(parsed)) return { ms: parsed, source: "message-created-at" };
    }
    return { ms: legacyMtimeMs, source: "history-file-mtime" };
  }

  function sessionChannel(sessionKey) {
    const parts = String(sessionKey || "").split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") || config.MAIN_KEY : config.MAIN_KEY;
  }

  function sessionLabel(channel) {
    if (channel === "heartbeat") return "Heartbeat";
    if (channel === config.MAIN_KEY) return "Main";
    return channel;
  }

  function countMessage(message) {
    const counts = emptyMessageCounts();
    counts.total = 1;
    if (message.role === "user") counts.user = 1;
    else if (message.role === "assistant") counts.assistant = 1;
    else if (message.role === "tool") counts.toolResults = 1;
    if (Array.isArray(message.tool_calls)) counts.toolCalls += message.tool_calls.length;
    if (message.error || message.errorMessage || message.role === "error") counts.errors = 1;
    return counts;
  }

  function estimateGroupTotals(messages) {
    const totals = { ...EMPTY_TOTALS };
    for (const message of messages) {
      const tokens = estimateTextTokens(message.content);
      if (message.role === "assistant") totals.output += tokens;
      else if (message.role === "tool") totals.output += tokens;
      else totals.input += tokens;
      totals.totalTokens += tokens;
    }
    return totals;
  }

  function addDailyMap(dailyMap, date, totals, messageCounts) {
    const current = dailyMap.get(date) || { date, ...EMPTY_TOTALS, messageCounts: emptyMessageCounts() };
    const nextTotals = addTotals(current, totals);
    dailyMap.set(date, {
      date,
      ...nextTotals,
      messageCounts: addMessageCounts(current.messageCounts, messageCounts),
    });
  }

  function sourceFromSet(set, emptyValue) {
    const concrete = [...set].filter((value) => value && value !== emptyValue);
    if (concrete.length === 0) return emptyValue;
    return new Set(concrete).size === 1 ? concrete[0] : "mixed";
  }

  function collectUsage(params = {}) {
    const { startMs, endMs } = parseDateRange(params);
    const limit = Math.max(0, Math.min(Number(params.limit) || 1000, 5000));
    const legacyMtimeMs = getHistoryFileMtimeMs();
    const sessions = [];
    let totals = { ...EMPTY_TOTALS };
    const dailyCost = new Map();
    const tokenSources = new Set();
    const costSources = new Set();
    const legacySources = new Set();

    for (const [sessionKey, rawMessages] of state.conversationHistory.entries()) {
      if (!Array.isArray(rawMessages) || rawMessages.length === 0) continue;
      const entries = rawMessages
        .map((message, index) => {
          const timestamp = messageTimestampMs(message, legacyMtimeMs);
          return { message, index, timestamp };
        })
        .filter((entry) => entry.timestamp.ms >= startMs && entry.timestamp.ms <= endMs);
      if (entries.length === 0) continue;

      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const agent = state.agentRegistry.get(agentId);
      const channel = sessionChannel(sessionKey);
      const settings = state.sessionSettings.get(sessionKey) || {};
      const fallbackModel = settings.model || agent?.settings?.model || config.HERMES_MODEL;
      const groups = new Map();
      for (const entry of entries) {
        const runId = typeof entry.message?.runId === "string" && entry.message.runId
          ? entry.message.runId
          : `legacy:${sessionKey}`;
        const group = groups.get(runId) || { runId, entries: [] };
        group.entries.push(entry);
        groups.set(runId, group);
      }

      let sessionTotals = { ...EMPTY_TOTALS };
      let sessionMessageCounts = emptyMessageCounts();
      const sessionDaily = new Map();
      const modelUsage = new Map();
      const tools = new Map();
      let updatedAt = 0;

      for (const group of groups.values()) {
        const messages = group.entries.map((entry) => entry.message);
        const groupDateMs = Math.max(...group.entries.map((entry) => entry.timestamp.ms));
        const groupDate = dateFromMs(groupDateMs);
        updatedAt = Math.max(updatedAt, groupDateMs);
        for (const entry of group.entries) legacySources.add(entry.timestamp.source);

        let groupMessageCounts = emptyMessageCounts();
        for (const message of messages) {
          groupMessageCounts = addMessageCounts(groupMessageCounts, countMessage(message));
          if (message.role === "tool") {
            const toolName = typeof message.name === "string" && message.name.trim()
              ? message.name.trim()
              : "tool";
            tools.set(toolName, (tools.get(toolName) || 0) + 1);
          }
        }

        const storedUsage = messages
          .map((message) => normalizeStoredTotals(message?.usage))
          .filter(Boolean)
          .reduce((acc, usage) => mergeUsageRecords(acc, usage), null);
        let groupTotals;
        if (storedUsage && storedUsage.tokenSource === "metadata") {
          groupTotals = storedUsage.totals;
          tokenSources.add(storedUsage.tokenSource);
        } else {
          groupTotals = estimateGroupTotals(messages);
          tokenSources.add(groupTotals.totalTokens > 0 ? "estimated" : "none");
        }
        if (storedUsage && storedUsage.costSource === "metadata") {
          groupTotals.inputCost = storedUsage.totals.inputCost;
          groupTotals.outputCost = storedUsage.totals.outputCost;
          groupTotals.cacheReadCost = storedUsage.totals.cacheReadCost;
          groupTotals.cacheWriteCost = storedUsage.totals.cacheWriteCost;
          groupTotals.totalCost = storedUsage.totals.totalCost;
          costSources.add("metadata");
        } else {
          costSources.add("none");
        }
        const durationMs = messages.reduce((sum, message) => sum + (finiteNumber(message?.durationMs) || 0), 0);
        groupTotals.durationMs += durationMs;

        const model = messages.find((message) => typeof message?.model === "string" && message.model.trim())?.model
          || fallbackModel;
        const provider =
          messages.find((message) => typeof message?.modelProvider === "string" && message.modelProvider.trim())?.modelProvider
          || "hermes";
        const modelKey = `${provider}::${model}`;
        const existingModel = modelUsage.get(modelKey) || {
          provider,
          model,
          count: 0,
          totals: { ...EMPTY_TOTALS },
        };
        existingModel.count += 1;
        existingModel.totals = addTotals(existingModel.totals, groupTotals);
        modelUsage.set(modelKey, existingModel);

        sessionTotals = addTotals(sessionTotals, groupTotals);
        totals = addTotals(totals, groupTotals);
        sessionMessageCounts = addMessageCounts(sessionMessageCounts, groupMessageCounts);
        addDailyMap(sessionDaily, groupDate, groupTotals, groupMessageCounts);
        addDailyMap(dailyCost, groupDate, groupTotals, groupMessageCounts);
      }

      sessions.push({
        key: sessionKey,
        label: sessionLabel(channel),
        agentId,
        channel,
        model: fallbackModel,
        modelProvider: "hermes",
        updatedAt,
        usage: {
          ...sessionTotals,
          totals: cloneJson(sessionTotals),
          messageCounts: sessionMessageCounts,
          toolUsage: {
            totalCalls: [...tools.values()].reduce((sum, value) => sum + value, 0),
            tools: [...tools.entries()].map(([name, count]) => ({ name, count })),
          },
          modelUsage: [...modelUsage.values()],
          dailyBreakdown: [...sessionDaily.values()].map((entry) => ({
            date: entry.date,
            tokens: entry.totalTokens,
            cost: entry.totalCost,
          })),
          dailyMessageCounts: [...sessionDaily.values()].map((entry) => ({
            date: entry.date,
            total: entry.messageCounts.total,
            toolCalls: entry.messageCounts.toolCalls,
            errors: entry.messageCounts.errors,
          })),
        },
      });
    }

    sessions.sort((left, right) => {
      const diff = (right.updatedAt || 0) - (left.updatedAt || 0);
      if (diff !== 0) return diff;
      return left.key.localeCompare(right.key);
    });

    const metadata = {
      runtime: "hermes",
      tokenSource: sourceFromSet(tokenSources, "none"),
      costSource: sourceFromSet(costSources, "none"),
      legacyDateSource: sourceFromSet(legacySources, "message-created-at"),
    };

    return {
      sessions: sessions.slice(0, limit),
      totals,
      daily: [...dailyCost.values()]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((entry) => ({
          date: entry.date,
          input: entry.input,
          output: entry.output,
          cacheRead: entry.cacheRead,
          cacheWrite: entry.cacheWrite,
          totalTokens: entry.totalTokens,
          inputCost: entry.inputCost,
          outputCost: entry.outputCost,
          cacheReadCost: entry.cacheReadCost,
          cacheWriteCost: entry.cacheWriteCost,
          totalCost: entry.totalCost,
        })),
      metadata,
    };
  }

  function buildSessionsUsage(params = {}) {
    const collected = collectUsage(params);
    return {
      sessions: collected.sessions,
      totals: collected.totals,
      aggregates: {},
      metadata: collected.metadata,
    };
  }

  function buildCostUsage(params = {}) {
    const collected = collectUsage(params);
    return {
      daily: collected.daily,
      metadata: collected.metadata,
    };
  }

  return {
    estimateTextTokens,
    normalizeHermesUsage: normalizeStoredTotals,
    mergeUsageRecords,
    createHistoryMessage,
    buildSessionsUsage,
    buildCostUsage,
  };
}

module.exports = { createUsage };
