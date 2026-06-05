"use strict";

const DISABLED_EVERY_VALUES = new Set(["disabled", "off", "none"]);

function createScheduler(ctx) {
  const { config, state, events, utils } = ctx;
  const { cloneJson, sanitizeErrorMessage } = utils;
  let timer = null;
  let ticking = false;

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function parseIntervalMs(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value !== "string") return null;
    const raw = value.trim().toLowerCase();
    if (!raw || DISABLED_EVERY_VALUES.has(raw)) return null;
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
    if (!match) return null;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2];
    const multiplier =
      unit === "ms" ? 1
        : unit === "s" || unit === "sec" || unit === "secs" || unit === "second" || unit === "seconds" ? 1000
          : unit === "m" || unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes" ? 60_000
            : unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours" ? 3_600_000
              : 86_400_000;
    return Math.round(amount * multiplier);
  }

  function scheduleHasAnchor(schedule) {
    return Object.prototype.hasOwnProperty.call(schedule || {}, "anchorMs");
  }

  function resolveCronNextRunAtMs(job, nowMs = Date.now()) {
    const schedule = utils.isPlainObject(job?.schedule) ? job.schedule : {};
    const jobState = utils.isPlainObject(job?.state) ? job.state : {};
    if (schedule.kind === "at") {
      const atMs = Date.parse(typeof schedule.at === "string" ? schedule.at : "");
      if (!Number.isFinite(atMs)) return null;
      const lastRunAtMs = finiteNumber(jobState.lastRunAtMs);
      if (lastRunAtMs !== null && atMs <= lastRunAtMs) return null;
      return atMs;
    }
    if (schedule.kind !== "every") return null;
    const everyMs = finiteNumber(schedule.everyMs);
    if (everyMs === null || everyMs <= 0) return null;
    const lastRunAtMs = finiteNumber(jobState.lastRunAtMs);
    if (lastRunAtMs !== null) return lastRunAtMs + everyMs;

    if (!scheduleHasAnchor(schedule)) {
      const currentNext = finiteNumber(jobState.nextRunAtMs);
      if (currentNext !== null) return currentNext;
      return nowMs + everyMs;
    }

    const anchorMs = finiteNumber(schedule.anchorMs);
    if (anchorMs === null) return nowMs + everyMs;
    if (anchorMs > nowMs) return anchorMs;
    const elapsed = nowMs - anchorMs;
    const intervals = Math.max(0, Math.floor(elapsed / everyMs));
    return anchorMs + intervals * everyMs;
  }

  function withCronNextRun(job, nowMs = Date.now()) {
    const next = cloneJson(job);
    const nextState = utils.isPlainObject(next.state) ? { ...next.state } : {};
    const nextRunAtMs = resolveCronNextRunAtMs(next, nowMs);
    if (nextRunAtMs === null) delete nextState.nextRunAtMs;
    else nextState.nextRunAtMs = nextRunAtMs;
    next.state = nextState;
    return next;
  }

  function getCronAutoSkipReason(job, nowMs = Date.now()) {
    if (!job) return "not-found";
    if (job.enabled === false) return "disabled";
    const jobState = utils.isPlainObject(job.state) ? job.state : {};
    if (finiteNumber(jobState.runningAtMs) !== null) return "running";
    const nextRunAtMs = finiteNumber(jobState.nextRunAtMs);
    if (nextRunAtMs === null) return "unsupported-schedule";
    if (nextRunAtMs > nowMs) return "not-due";
    return null;
  }

  function resolveHeartbeatConfig(agentId) {
    const adapterConfig = state.getAdapterConfig();
    const agents = utils.isPlainObject(adapterConfig.agents) ? adapterConfig.agents : {};
    const defaults = utils.isPlainObject(agents.defaults) && utils.isPlainObject(agents.defaults.heartbeat)
      ? agents.defaults.heartbeat
      : {};
    const agentEntry = state.getConfigAgentList(adapterConfig).find((entry) => entry.id === agentId) || {};
    const override = utils.isPlainObject(agentEntry.heartbeat) ? agentEntry.heartbeat : {};
    const merged = { ...defaults, ...override };
    const every = typeof merged.every === "string" ? merged.every.trim() : "";
    const loweredEvery = every.toLowerCase();
    const everyMs = parseIntervalMs(every);
    const enabled = Boolean(every && !DISABLED_EVERY_VALUES.has(loweredEvery) && everyMs);
    return { agentId, every, everyMs, enabled };
  }

  function ensureHeartbeatState(agentId, everyMs, nowMs = Date.now()) {
    const existing = state.heartbeatStateByAgentId.get(agentId) || {};
    if (!everyMs) {
      state.heartbeatStateByAgentId.delete(agentId);
      return {};
    }
    const next = { ...existing };
    if (finiteNumber(next.runningAtMs) === null && finiteNumber(next.nextRunAtMs) === null) {
      next.nextRunAtMs = nowMs + everyMs;
    }
    state.heartbeatStateByAgentId.set(agentId, next);
    state.persistAdapterState();
    return next;
  }

  function buildHeartbeatStatus(agentId, nowMs = Date.now()) {
    const resolved = resolveHeartbeatConfig(agentId);
    if (!resolved.enabled || !resolved.everyMs) {
      return {
        agentId,
        enabled: false,
        ...(resolved.every ? { every: resolved.every } : {}),
        state: {},
      };
    }
    const heartbeatState = ensureHeartbeatState(agentId, resolved.everyMs, nowMs);
    return {
      agentId,
      enabled: true,
      every: resolved.every,
      everyMs: resolved.everyMs,
      state: cloneJson(heartbeatState),
    };
  }

  function getHeartbeatAutoSkipReason(agentId, nowMs = Date.now()) {
    const resolved = resolveHeartbeatConfig(agentId);
    if (!resolved.enabled || !resolved.everyMs) return "disabled";
    const heartbeatState = ensureHeartbeatState(agentId, resolved.everyMs, nowMs);
    if (finiteNumber(heartbeatState.runningAtMs) !== null) return "running";
    const nextRunAtMs = finiteNumber(heartbeatState.nextRunAtMs);
    if (nextRunAtMs === null || nextRunAtMs > nowMs) return "not-due";
    return null;
  }

  async function tick(handleMethod) {
    if (ticking) return;
    ticking = true;
    try {
      const nowMs = Date.now();
      for (const rawJob of [...state.cronJobs.values()]) {
        const normalized = withCronNextRun(rawJob, nowMs);
        state.cronJobs.set(normalized.id, normalized);
        const reason = getCronAutoSkipReason(normalized, nowMs);
        if (reason) continue;
        void handleMethod(
          "cron.run",
          { id: normalized.id, mode: "auto" },
          `scheduler:cron:${normalized.id}:${nowMs}`,
          events.broadcastEvent
        );
      }
      for (const agentId of [...state.agentRegistry.keys()]) {
        const reason = getHeartbeatAutoSkipReason(agentId, nowMs);
        if (reason) continue;
        void handleMethod(
          "wake",
          { agentId, mode: "auto", text: `Claw3D heartbeat trigger (${agentId}).` },
          `scheduler:heartbeat:${agentId}:${nowMs}`,
          events.broadcastEvent
        );
      }
      state.persistAdapterState();
    } catch (err) {
      console.warn("[hermes-adapter] Scheduler tick failed:", sanitizeErrorMessage(err));
    } finally {
      ticking = false;
    }
  }

  function start(handleMethod) {
    if (timer) return { stop };
    const intervalMs = Math.max(1000, Number.parseInt(process.env.HERMES_ADAPTER_SCHEDULER_INTERVAL_MS || "30000", 10) || 30000);
    void tick(handleMethod);
    timer = setInterval(() => {
      void tick(handleMethod);
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return { stop };
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    parseIntervalMs,
    resolveCronNextRunAtMs,
    withCronNextRun,
    getCronAutoSkipReason,
    resolveHeartbeatConfig,
    buildHeartbeatStatus,
    getHeartbeatAutoSkipReason,
    tick,
    start,
    stop,
  };
}

module.exports = { createScheduler };
