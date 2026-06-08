"use strict";

const crypto = require("crypto");

function createHandleMethod(ctx) {
  const { config, state, workspaceFiles, hermes, profiles, skills, usage, orchestration, scheduler, utils } = ctx;
  const {
    cloneJson,
    randomId,
    resolveAgentIdFromSessionKey,
    sanitizeErrorMessage,
    resOk,
    resErr,
  } = utils;
  const STORED_ONLY_EXEC_ENFORCEMENT = {
    mode: "stored-only",
    enforced: false,
    runtime: "hermes",
  };
  const TASK_STATUSES = new Set(["todo", "in_progress", "blocked", "review", "done"]);
  const TASK_SOURCES = new Set(["openclaw_event", "claw3d_manual", "playbook", "fallback_inferred"]);

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeNullableString(value) {
    if (value === null) return null;
    const trimmed = trimString(value);
    return trimmed || null;
  }

  function normalizeStringArray(value) {
    return Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
      : [];
  }

  function normalizePathString(value) {
    return trimString(value).replace(/[\\/]+$/, "");
  }

  function normalizeTaskSource(value) {
    const source = trimString(value);
    return TASK_SOURCES.has(source) ? source : "claw3d_manual";
  }

  function normalizeTaskStatus(value, fallback = "todo") {
    const status = trimString(value);
    return TASK_STATUSES.has(status) ? status : fallback;
  }

  function validateTaskStatus(value) {
    if (value === undefined) return null;
    const status = trimString(value);
    return TASK_STATUSES.has(status) ? status : null;
  }

  function sortTasks(tasks) {
    return [...tasks].sort((left, right) => {
      const rightTime = Date.parse(right.updatedAt || "");
      const leftTime = Date.parse(left.updatedAt || "");
      const timeDiff = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      if (timeDiff !== 0) return timeDiff;
      return String(left.id || "").localeCompare(String(right.id || ""));
    });
  }

  function createTaskRecord(input) {
    const title = trimString(input.title);
    if (!title) throw new Error("Task title is required.");
    const now = new Date().toISOString();
    const status = normalizeTaskStatus(input.status);
    return {
      id: `task-${randomId().slice(0, 10)}`,
      title,
      description: trimString(input.description),
      status,
      source: normalizeTaskSource(input.source),
      sourceEventId: normalizeNullableString(input.sourceEventId),
      assignedAgentId: normalizeNullableString(input.assignedAgentId),
      createdAt: now,
      updatedAt: now,
      playbookJobId: normalizeNullableString(input.playbookJobId),
      runId: normalizeNullableString(input.runId),
      channel: normalizeNullableString(input.channel),
      externalThreadId: normalizeNullableString(input.externalThreadId),
      lastActivityAt: normalizeNullableString(input.lastActivityAt),
      notes: normalizeStringArray(input.notes),
      archived: Boolean(input.archived),
    };
  }

  function applyTaskPatch(task, patch) {
    const next = { ...task };
    if (patch.title !== undefined) {
      const title = trimString(patch.title);
      if (!title) throw new Error("Task title is required.");
      next.title = title;
    }
    if (patch.description !== undefined) next.description = trimString(patch.description);
    if (patch.status !== undefined) {
      const status = validateTaskStatus(patch.status);
      if (!status) throw new Error("Invalid task status.");
      next.status = status;
    }
    if (patch.assignedAgentId !== undefined) next.assignedAgentId = normalizeNullableString(patch.assignedAgentId);
    if (patch.playbookJobId !== undefined) next.playbookJobId = normalizeNullableString(patch.playbookJobId);
    if (patch.runId !== undefined) next.runId = normalizeNullableString(patch.runId);
    if (patch.channel !== undefined) next.channel = normalizeNullableString(patch.channel);
    if (patch.externalThreadId !== undefined) next.externalThreadId = normalizeNullableString(patch.externalThreadId);
    if (patch.sourceEventId !== undefined) next.sourceEventId = normalizeNullableString(patch.sourceEventId);
    if (patch.notes !== undefined) next.notes = normalizeStringArray(patch.notes);
    if (patch.archived !== undefined) next.archived = Boolean(patch.archived);
    next.updatedAt = new Date().toISOString();
    return next;
  }

  function resolveHeartbeatBlock(agentId) {
    return scheduler.buildHeartbeatStatus(agentId);
  }

  function buildHeartbeatStatusAgents() {
    return [...state.agentRegistry.keys()].map((agentId) => resolveHeartbeatBlock(agentId));
  }

  let warnedProfileFallback = false;
  let warnedNativeSessionFallback = false;

  function agentToGatewayEntry(agent) {
    const entry = {
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
      identity: { name: agent.name, emoji: "🤖" },
      role: agent.role,
    };
    if (utils.isPlainObject(agent.metadata)) {
      entry.metadata = cloneJson(agent.metadata);
    }
    return entry;
  }

  function logProfileFallback(err) {
    if (warnedProfileFallback) return;
    warnedProfileFallback = true;
    console.warn(
      "[hermes-adapter] Hermes profile API unavailable; using compat fallback:",
      sanitizeErrorMessage(err)
    );
  }

  function listAdapterRegistryAgents() {
    return [...state.agentRegistry.values()].map((agent) => state.normalizeAgentRecord(agent, agent));
  }

  function syncProfileAgents(profileRecords) {
    const profileAgentIds = new Set();
    const agents = [];

    for (const profileRecord of profileRecords) {
      const fallback = state.agentRegistry.get(
        profiles.agentIdForProfileName(profileRecord.name, profileRecord.isDefault)
      );
      const agent = state.normalizeAgentRecord(
        profiles.profileToAgent(profileRecord, fallback),
        fallback
      );
      profileAgentIds.add(agent.id);
      agents.push(agent);
      state.agentRegistry.set(agent.id, agent);
      state.upsertConfigAgent(agent);
    }

    for (const agent of [...state.agentRegistry.values()]) {
      const isProfileAgent = agent.metadata?.hermesProfileSource === "dashboard";
      if (isProfileAgent && !profileAgentIds.has(agent.id)) {
        state.agentRegistry.delete(agent.id);
        state.removeConfigAgent(agent.id);
        continue;
      }
      if (profileAgentIds.has(agent.id)) continue;
      agents.push(agent);
    }

    state.persistAdapterState();
    return agents;
  }

  async function resolveVisibleAgents() {
    if (!profiles?.isConfigured?.()) {
      return { profileBacked: false, agents: listAdapterRegistryAgents() };
    }
    try {
      const profileRecords = await profiles.listProfiles();
      return { profileBacked: true, agents: syncProfileAgents(profileRecords) };
    } catch (err) {
      logProfileFallback(err);
      return { profileBacked: false, agents: listAdapterRegistryAgents() };
    }
  }

  function buildConfigWithAgents(agents) {
    const baseConfig = cloneJson(state.getAdapterConfig());
    const currentAgents = utils.isPlainObject(baseConfig.agents) ? baseConfig.agents : {};
    return {
      ...baseConfig,
      agents: {
        ...currentAgents,
        list: agents.map((agent) => state.agentToConfigEntry(agent)),
      },
    };
  }

  function buildSessionEntry(sessionKey, agent) {
    const parts = sessionKey.split(":");
    const sessionName = parts.length >= 3 ? parts.slice(2).join(":") : config.MAIN_KEY;
    const history = state.getHistory(sessionKey);
    const settings = state.sessionSettings.get(sessionKey) || {};
    const isActive = [...state.activeRuns.values()].some((run) => run.sessionKey === sessionKey);
    const isHeartbeat = sessionName === "heartbeat";
    return {
      key: sessionKey,
      agentId: agent?.id || resolveAgentIdFromSessionKey(sessionKey),
      updatedAt: history.length > 0 || isActive ? Date.now() : null,
      displayName: isHeartbeat ? "Heartbeat" : (sessionName === config.MAIN_KEY ? "Main" : sessionName),
      origin: { label: isHeartbeat ? "heartbeat" : (agent?.name || sessionName), provider: "hermes" },
      model: settings.model || agent?.settings?.model || config.HERMES_MODEL,
      modelProvider: "hermes",
    };
  }

  function sessionChannelFromKey(sessionKey) {
    const parts = String(sessionKey || "").split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") || config.MAIN_KEY : config.MAIN_KEY;
  }

  function sessionDisplayName(sessionKey) {
    const channel = sessionChannelFromKey(sessionKey);
    if (channel === "heartbeat") return "Heartbeat";
    return channel === config.MAIN_KEY ? "Main" : channel;
  }

  function hermesSessionIdForGatewayKey(sessionKey) {
    const hash = crypto.createHash("sha256").update(String(sessionKey || "")).digest("hex").slice(0, 24);
    return `claw3d-${hash}`;
  }

  function isNotFoundError(err) {
    return err?.statusCode === 404 || /\b404\b/.test(sanitizeErrorMessage(err));
  }

  function isNativeSessionAgent(agentId) {
    if (!agentId || agentId === config.AGENT_ID) return false;
    const agent = state.agentRegistry.get(agentId);
    const profileName = trimString(agent?.metadata?.hermesProfileName);
    return Boolean(profileName && profileName !== "default");
  }

  function nativeProfileNameForAgent(agentId) {
    const agent = state.agentRegistry.get(agentId);
    return trimString(agent?.metadata?.hermesProfileName) || agentId;
  }

  function logNativeSessionFallback(err) {
    if (warnedNativeSessionFallback) return;
    warnedNativeSessionFallback = true;
    console.warn(
      "[hermes-adapter] Hermes native session API unavailable; using compat fallback:",
      sanitizeErrorMessage(err)
    );
  }

  function textFromHermesMessage(message) {
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
      return message.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        })
        .join("");
    }
    if (typeof message?.text === "string") return message.text;
    return "";
  }

  function normalizeHermesMessage(message) {
    const role = message?.role === "assistant" ? "assistant" : (message?.role === "tool" ? "tool" : "user");
    const normalized = {
      role,
      content: textFromHermesMessage(message),
    };
    if (typeof message?.createdAtMs === "number") normalized.createdAtMs = message.createdAtMs;
    else if (typeof message?.created_at === "string") {
      const parsed = Date.parse(message.created_at);
      if (Number.isFinite(parsed)) normalized.createdAtMs = parsed;
    }
    return normalized;
  }

  async function readNativeMessages(sessionKey) {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    if (!isNativeSessionAgent(agentId)) return null;
    const messages = await hermes.listNativeSessionMessages(hermesSessionIdForGatewayKey(sessionKey));
    return messages.map((message) => normalizeHermesMessage(message));
  }

  async function ensureNativeSession(sessionKey, agent, model) {
    const sessionId = hermesSessionIdForGatewayKey(sessionKey);
    try {
      await hermes.getNativeSession(sessionId);
      return sessionId;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    await hermes.createNativeSession({
      sessionId,
      title: sessionDisplayName(sessionKey),
      model,
      systemPrompt: agent?.systemPrompt,
    });
    return sessionId;
  }

  function storeNativeTranscript({ sessionKey, messages, fallbackUserMessage, fallbackAssistantText, runId, model, usageRecord, durationMs }) {
    const now = Date.now();
    const sourceMessages = Array.isArray(messages) && messages.length > 0
      ? messages
      : [
          { role: "user", content: fallbackUserMessage },
          { role: "assistant", content: fallbackAssistantText },
        ];
    const normalized = sourceMessages
      .map((message) => normalizeHermesMessage(message))
      .filter((message) => message.content || message.role === "assistant" || message.role === "user")
      .map((message, index, all) => {
        const entry = {
          ...message,
          createdAtMs: typeof message.createdAtMs === "number" ? message.createdAtMs : now,
          runId,
          model,
          modelProvider: "hermes",
        };
        if (index === all.length - 1 && entry.role === "assistant") {
          if (usageRecord) entry.usage = usageRecord;
          if (typeof durationMs === "number") entry.durationMs = durationMs;
        }
        return entry;
      });
    const existing = state.getHistory(sessionKey);
    state.conversationHistory.set(sessionKey, [...existing, ...normalized]);
    state.saveHistoryToDisk();
  }

  function buildSessionEntryFromNative(sessionKey, agent, nativeSession) {
    const entry = buildSessionEntry(sessionKey, agent);
    const updatedAt = Date.parse(nativeSession?.updated_at || nativeSession?.updatedAt || nativeSession?.last_message_at || "");
    if (Number.isFinite(updatedAt)) entry.updatedAt = updatedAt;
    if (typeof nativeSession?.title === "string" && nativeSession.title.trim()) {
      entry.displayName = nativeSession.title.trim();
    }
    if (typeof nativeSession?.model === "string" && nativeSession.model.trim()) {
      entry.model = nativeSession.model.trim();
    }
    entry.metadata = {
      ...(utils.isPlainObject(entry.metadata) ? entry.metadata : {}),
      hermesSessionId: hermesSessionIdForGatewayKey(sessionKey),
      hermesSessionSource: "native",
    };
    return entry;
  }

  function startChatRun({ sessionKey, userMessage, runId, sendEvent, onDone }) {
    const trimmedMessage = trimString(userMessage);
    if (!trimmedMessage) return { status: "no-op", runId };

    const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
    const agent = state.agentRegistry.get(sessionAgentId);
    const isOrchestrator = sessionAgentId === config.AGENT_ID;
    let aborted = false;

    state.activeRuns.set(runId, {
      runId,
      sessionKey,
      agentId: sessionAgentId,
      abort() { aborted = true; },
    });

    setImmediate(async () => {
      const startedAtMs = Date.now();
      const model = (state.sessionSettings.get(sessionKey) || {}).model
        || agent?.settings?.model || config.HERMES_MODEL;
      let seqCounter = 0;

      const emitChat = (stateName, extra) => {
        sendEvent({
          type: "event",
          event: "chat",
          seq: seqCounter++,
          payload: { runId, sessionKey, state: stateName, ...extra },
        });
      };

      const onTextDelta = (partial) => {
        if (!aborted) emitChat("delta", { message: { role: "assistant", content: partial } });
      };

      try {
        const tools = isOrchestrator ? orchestration.TEAM_TOOLS : [];
        const finalText = await orchestration.runAgenticLoop({
          sessionKey,
          agentId: sessionAgentId,
          userMessage: trimmedMessage,
          model,
          tools,
          emitDelta: onTextDelta,
          abortCheck: () => aborted,
          sendEvent,
          runId,
          startedAtMs,
        });

        if (aborted) {
          emitChat("aborted", {});
          if (onDone) onDone({ status: "aborted", durationMs: Date.now() - startedAtMs });
        } else {
          emitChat("final", {
            stopReason: "end_turn",
            message: { role: "assistant", content: finalText },
          });
          sendEvent({
            type: "event",
            event: "presence",
            seq: seqCounter++,
            payload: {
              sessions: {
                recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
              },
            },
          });
          if (onDone) onDone({ status: "ok", finalText, durationMs: Date.now() - startedAtMs });
        }
      } catch (err) {
        const errorMessage = sanitizeErrorMessage(err) || "Hermes API error";
        if (!aborted) emitChat("error", { errorMessage });
        else emitChat("aborted", {});
        if (onDone) onDone({ status: aborted ? "aborted" : "error", errorMessage, durationMs: Date.now() - startedAtMs });
      } finally {
        state.activeRuns.delete(runId);
      }
    });

    return { status: "started", runId };
  }

  function startNativeSessionChatRun({ sessionKey, userMessage, runId, sendEvent, onDone }) {
    const trimmedMessage = trimString(userMessage);
    if (!trimmedMessage) return { status: "no-op", runId };

    const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
    const agent = state.agentRegistry.get(sessionAgentId);
    let aborted = false;

    state.activeRuns.set(runId, {
      runId,
      sessionKey,
      agentId: sessionAgentId,
      abort() { aborted = true; },
    });

    setImmediate(async () => {
      const startedAtMs = Date.now();
      const model = (state.sessionSettings.get(sessionKey) || {}).model
        || agent?.settings?.model || config.HERMES_MODEL;
      let seqCounter = 0;
      let handedToCompatFallback = false;

      const emitChat = (stateName, extra) => {
        sendEvent({
          type: "event",
          event: "chat",
          seq: seqCounter++,
          payload: { runId, sessionKey, state: stateName, ...extra },
        });
      };

      try {
        const sessionId = await ensureNativeSession(sessionKey, agent, model);
        const result = await hermes.streamNativeSessionChat({
          sessionId,
          sessionKey,
          message: trimmedMessage,
          model,
          profileName: nativeProfileNameForAgent(sessionAgentId),
          abortCheck: () => aborted,
          onTextDelta(partial) {
            if (!aborted) emitChat("delta", { message: { role: "assistant", content: partial } });
          },
        });
        const durationMs = Date.now() - startedAtMs;
        const finalText = result.textContent || textFromHermesMessage(
          Array.isArray(result.messages)
            ? [...result.messages].reverse().find((message) => message?.role === "assistant")
            : null
        );

        if (aborted) {
          emitChat("aborted", {});
          if (onDone) onDone({ status: "aborted", durationMs });
        } else {
          storeNativeTranscript({
            sessionKey,
            messages: result.messages,
            fallbackUserMessage: trimmedMessage,
            fallbackAssistantText: finalText,
            runId,
            model,
            usageRecord: result.usage,
            durationMs,
          });
          emitChat("final", {
            stopReason: result.finishReason || "end_turn",
            message: { role: "assistant", content: finalText },
          });
          sendEvent({
            type: "event",
            event: "presence",
            seq: seqCounter++,
            payload: {
              sessions: {
                recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
              },
            },
          });
          if (onDone) onDone({ status: "ok", finalText, durationMs });
        }
      } catch (err) {
        state.activeRuns.delete(runId);
        if (aborted) {
          emitChat("aborted", {});
          if (onDone) onDone({ status: "aborted", durationMs: Date.now() - startedAtMs });
          return;
        }
        logNativeSessionFallback(err);
        handedToCompatFallback = true;
        startChatRun({ sessionKey, userMessage: trimmedMessage, runId, sendEvent, onDone });
        return;
      } finally {
        if (!handedToCompatFallback && state.activeRuns.get(runId)?.sessionKey === sessionKey) {
          state.activeRuns.delete(runId);
        }
      }
    });

    return { status: "started", runId };
  }

  function resolveCronPrompt(job) {
    const payload = utils.isPlainObject(job.payload) ? job.payload : {};
    if (payload.kind === "agentTurn" && trimString(payload.message)) return trimString(payload.message);
    if (payload.kind === "systemEvent" && trimString(payload.text)) return trimString(payload.text);
    return `Run scheduled task: ${job.name || job.id}`;
  }

  function resolveWakeAgentId(input) {
    const directAgentId = trimString(input.agentId);
    if (directAgentId) return directAgentId;
    const text = trimString(input.text);
    const match = text.match(/\(([^)]+)\)/);
    return match?.[1]?.trim() || config.AGENT_ID;
  }

  function runHeartbeat({ agentId, text, runId, sendEvent }) {
    const sessionKey = `agent:${agentId}:heartbeat`;
    const heartbeatRunId = runId || `heartbeat:${agentId}:${randomId()}`;
    const message = trimString(text) || `Claw3D heartbeat trigger (${agentId}).`;
    const resolved = scheduler.resolveHeartbeatConfig(agentId);
    const startedAtMs = Date.now();
    const existingState = state.heartbeatStateByAgentId.get(agentId) || {};
    state.heartbeatStateByAgentId.set(agentId, { ...existingState, runningAtMs: startedAtMs });
    state.persistAdapterState();
    sendEvent({
      type: "event",
      event: "heartbeat",
      payload: { action: "started", agentId, sessionKey, runId: heartbeatRunId, text: message, timestamp: startedAtMs },
    });
    const result = startChatRun({
      sessionKey,
      userMessage: message,
      runId: heartbeatRunId,
      sendEvent,
      onDone(outcome) {
        const current = state.heartbeatStateByAgentId.get(agentId) || {};
        const { runningAtMs: _runningAtMs, ...restState } = current;
        const lastStatus = outcome.status === "ok" ? "ok" : (outcome.status === "aborted" ? "skipped" : "error");
        const nextState = {
          ...restState,
          lastRunAtMs: Date.now(),
          lastStatus,
          lastDurationMs: outcome.durationMs,
        };
        if (resolved.everyMs && lastStatus === "ok") {
          nextState.nextRunAtMs = Date.now() + resolved.everyMs;
        }
        if (outcome.errorMessage) nextState.lastError = outcome.errorMessage;
        else delete nextState.lastError;
        state.heartbeatStateByAgentId.set(agentId, nextState);
        state.persistAdapterState();
        sendEvent({
          type: "event",
          event: "heartbeat",
          payload: { action: "finished", agentId, sessionKey, runId: heartbeatRunId, status: lastStatus, timestamp: Date.now() },
        });
      },
    });
    return { ok: result.status !== "no-op", runId: heartbeatRunId };
  }

  return async function handleMethod(method, params, id, sendEvent) {
    const p = params || {};

    switch (method) {
      case "agents.list": {
        const { agents } = await resolveVisibleAgents();
        const allAgents = agents.map(agentToGatewayEntry);
        return resOk(id, { defaultId: config.AGENT_ID, mainKey: config.MAIN_KEY, agents: allAgents });
      }

      case "agents.create": {
        const agentName = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Agent";
        if (profiles?.isConfigured?.()) {
          const profileName = profiles.slugifyProfileName(agentName);
          const role = trimString(p.role);
          try {
            const profileRecord = await profiles.createProfile({
              name: profileName,
              description: role,
              cloneFromDefault: true,
              provider: p.provider,
              model: p.model,
            });
            const agent = state.normalizeAgentRecord(
              profiles.profileToAgent(profileRecord, {
                name: profileRecord.name || profileName,
                role,
              }),
              undefined
            );
            state.agentRegistry.set(agent.id, agent);
            state.upsertConfigAgent(agent);
            state.persistAdapterState();
            return resOk(id, {
              agentId: agent.id,
              name: agentName,
              workspace: agent.workspace,
              metadata: { hermesProfileName: profileRecord.name },
            });
          } catch (err) {
            return resErr(id, "invalid_request", sanitizeErrorMessage(err));
          }
        }
        const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const newId = `${slug}-${randomId().slice(0, 6)}`;
        const workspace = (typeof p.workspace === "string" && p.workspace)
          ? p.workspace
          : `${config.HOME}/.hermes/workspace-${slug}`;
        const agent = {
          id: newId,
          name: agentName,
          workspace,
          role: "",
          systemPrompt: `You are ${agentName}.`,
          settings: { wipe: false, continuity: true, model: config.HERMES_MODEL },
        };
        try {
          workspaceFiles.ensureBootstrapFiles(agent);
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
        state.agentRegistry.set(newId, agent);
        state.upsertConfigAgent(agent);
        state.persistAdapterState();
        return resOk(id, { agentId: newId, name: agentName, workspace });
      }

      case "agents.delete": {
        const delId = typeof p.agentId === "string" ? p.agentId : "";
        if (profiles?.isConfigured?.()) {
          if (!delId) return resErr(id, "invalid_request", "agentId is required.");
          const profileName = profiles.profileNameForAgentId(delId);
          if (profileName === "default") {
            return resErr(id, "invalid_request", "Cannot delete the default Hermes profile.");
          }
          try {
            await profiles.deleteProfile(profileName);
          } catch (err) {
            return resErr(id, "invalid_request", sanitizeErrorMessage(err));
          }
          state.agentRegistry.delete(delId);
          state.removeConfigAgent(delId);
          state.persistAdapterState();
          state.clearHistory(`agent:${delId}:${config.MAIN_KEY}`);
          return resOk(id, { ok: true, removedBindings: 0 });
        }
        if (delId && delId !== config.AGENT_ID) {
          state.agentRegistry.delete(delId);
          state.removeConfigAgent(delId);
          state.persistAdapterState();
          state.clearHistory(`agent:${delId}:${config.MAIN_KEY}`);
        }
        return resOk(id, { ok: true, removedBindings: 0 });
      }

      case "agents.update": {
        const updId = typeof p.agentId === "string" ? p.agentId : "";
        if (profiles?.isConfigured?.()) {
          if (!updId) return resErr(id, "invalid_request", "agentId is required.");
          const profileName = profiles.profileNameForAgentId(updId);
          const requestedName = trimString(p.name);
          if (requestedName && profileName === "default") {
            return resErr(id, "invalid_request", "Cannot rename the default Hermes profile.");
          }
          let nextAgentId = updId;
          let renamed = false;
          try {
            if (typeof p.role === "string") {
              await profiles.updateProfileDescription(profileName, p.role);
              const existing = state.agentRegistry.get(updId);
              if (existing) {
                existing.role = trimString(p.role);
                state.upsertConfigAgent(existing);
              }
            }
            if (requestedName) {
              const nextProfileName = profiles.slugifyProfileName(requestedName);
              if (nextProfileName !== profileName) {
                await profiles.renameProfile(profileName, nextProfileName);
                nextAgentId = profiles.agentIdForProfileName(nextProfileName, false);
                const existing = state.agentRegistry.get(updId);
                if (existing) {
                  existing.id = nextAgentId;
                  existing.name = nextProfileName;
                  existing.metadata = {
                    ...(utils.isPlainObject(existing.metadata) ? existing.metadata : {}),
                    hermesProfileName: nextProfileName,
                  };
                }
                state.renameAgentReferences(updId, nextAgentId);
                renamed = true;
              }
            }
            state.persistAdapterState();
          } catch (err) {
            return resErr(id, "invalid_request", sanitizeErrorMessage(err));
          }
          return resOk(id, {
            ok: true,
            removedBindings: 0,
            ...(renamed ? { previousAgentId: updId, agentId: nextAgentId, newAgentId: nextAgentId } : {}),
          });
        }
        const existing = state.agentRegistry.get(updId);
        if (existing) {
          if (typeof p.name === "string" && p.name.trim()) existing.name = p.name.trim();
          if (typeof p.workspace === "string" && p.workspace.trim()) existing.workspace = p.workspace.trim();
          if (typeof p.role === "string") existing.role = p.role.trim();
          state.upsertConfigAgent(existing);
          state.persistAdapterState();
        }
        return resOk(id, { ok: true, removedBindings: 0 });
      }

      case "agents.files.get": {
        const targetAgentId = typeof p.agentId === "string" && p.agentId.trim()
          ? p.agentId.trim()
          : config.AGENT_ID;
        const fileAgent = state.agentRegistry.get(targetAgentId);
        if (!fileAgent) {
          return resErr(id, "not_found", `Agent not found: ${targetAgentId}`);
        }
        try {
          return resOk(id, workspaceFiles.readAgentFile(fileAgent, p.name));
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
      }

      case "agents.files.list": {
        const targetAgentId = typeof p.agentId === "string" && p.agentId.trim()
          ? p.agentId.trim()
          : config.AGENT_ID;
        const fileAgent = state.agentRegistry.get(targetAgentId);
        if (!fileAgent) {
          return resErr(id, "not_found", `Agent not found: ${targetAgentId}`);
        }
        try {
          return resOk(id, workspaceFiles.listAgentFiles(fileAgent));
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
      }

      case "agents.files.set": {
        const targetAgentId = typeof p.agentId === "string" && p.agentId.trim()
          ? p.agentId.trim()
          : config.AGENT_ID;
        const fileAgent = state.agentRegistry.get(targetAgentId);
        if (!fileAgent) {
          return resErr(id, "not_found", `Agent not found: ${targetAgentId}`);
        }
        try {
          return resOk(id, workspaceFiles.writeAgentFile(fileAgent, p.name, p.content));
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
      }

      case "config.get": {
        const { profileBacked, agents } = await resolveVisibleAgents();
        return resOk(id, {
          config: profileBacked ? buildConfigWithAgents(agents) : cloneJson(state.getAdapterConfig()),
          hash: state.computeConfigHash(),
          exists: true,
          path: config.CONFIG_PATH,
        });
      }

      case "config.set": {
        const currentHash = state.computeConfigHash();
        if (p.baseHash !== undefined && String(p.baseHash).trim() !== currentHash) {
          return resErr(id, "invalid_request", config.CONFIG_CHANGED_MESSAGE);
        }
        let nextConfig;
        try {
          nextConfig = state.parseConfigRaw(p.raw);
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
        state.replaceAdapterConfig(nextConfig);
        state.reconcileAgentRegistryFromConfig({ pruneNonDefault: true });
        state.persistAdapterState();
        return resOk(id, { hash: state.computeConfigHash() });
      }

      case "config.patch": {
        const currentHash = state.computeConfigHash();
        if (p.baseHash !== undefined && String(p.baseHash).trim() !== currentHash) {
          return resErr(id, "invalid_request", config.CONFIG_CHANGED_MESSAGE);
        }
        let patch;
        try {
          patch = state.parseConfigRaw(p.raw);
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
        state.patchAdapterConfig(patch);
        state.reconcileAgentRegistryFromConfig({ pruneNonDefault: true });
        state.persistAdapterState();
        return resOk(id, { hash: state.computeConfigHash() });
      }

      case "sessions.list": {
        if (profiles?.isConfigured?.()) {
          await resolveVisibleAgents();
        }
        const sessionKeys = new Set();
        for (const agent of state.agentRegistry.values()) {
          sessionKeys.add(`agent:${agent.id}:${config.MAIN_KEY}`);
        }
        for (const [key, messages] of state.conversationHistory.entries()) {
          if (Array.isArray(messages) && messages.length > 0) sessionKeys.add(key);
        }
        for (const run of state.activeRuns.values()) {
          sessionKeys.add(run.sessionKey);
        }
        let nativeSessionsById = new Map();
        if ([...state.agentRegistry.keys()].some((agentId) => isNativeSessionAgent(agentId))) {
          try {
            const nativeSessions = await hermes.listNativeSessions({ limit: 100, offset: 0 });
            nativeSessionsById = new Map(
              nativeSessions
                .filter((session) => typeof session?.id === "string")
                .map((session) => [session.id, session])
            );
          } catch (err) {
            logNativeSessionFallback(err);
          }
        }
        const sessions = [...sessionKeys].map((sessionKey) => {
          const agentId = resolveAgentIdFromSessionKey(sessionKey);
          const agent = state.agentRegistry.get(agentId);
          const nativeSession = nativeSessionsById.get(hermesSessionIdForGatewayKey(sessionKey));
          if (nativeSession && isNativeSessionAgent(agentId)) {
            return buildSessionEntryFromNative(sessionKey, agent, nativeSession);
          }
          return buildSessionEntry(sessionKey, agent);
        });
        return resOk(id, { sessions });
      }

      case "sessions.preview": {
        const keys = Array.isArray(p.keys) ? p.keys : [];
        const limit = typeof p.limit === "number" ? p.limit : 8;
        const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
        const previews = await Promise.all(keys.map(async (key) => {
          try {
            const nativeMessages = await readNativeMessages(key);
            if (nativeMessages) {
              if (nativeMessages.length === 0) return { key, status: "empty", items: [] };
              const items = nativeMessages.slice(-limit).map((msg) => ({
                role: msg.role === "assistant" ? "assistant" : "user",
                text: String(msg.content || "").slice(0, maxChars),
                timestamp: msg.createdAtMs || Date.now(),
              }));
              return { key, status: "ok", items };
            }
          } catch (err) {
            logNativeSessionFallback(err);
          }
          const history = state.getHistory(key);
          if (history.length === 0) return { key, status: "empty", items: [] };
          const items = history.slice(-limit).map((msg) => ({
            role: msg.role === "assistant" ? "assistant" : "user",
            text: String(msg.content || "").slice(0, maxChars),
            timestamp: Date.now(),
          }));
          return { key, status: "ok", items };
        }));
        return resOk(id, { ts: Date.now(), previews });
      }

      case "sessions.usage":
        return resOk(id, usage.buildSessionsUsage(p));

      case "sessions.patch": {
        const key = typeof p.key === "string" ? p.key : config.MAIN_SESSION_KEY;
        const current = state.sessionSettings.get(key) || {};
        const next = { ...current };
        if (p.model !== undefined) next.model = typeof p.model === "string" ? p.model.trim() : p.model;
        if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
        if (p.execHost !== undefined) next.execHost = p.execHost;
        if (p.execSecurity !== undefined) next.execSecurity = p.execSecurity;
        if (p.execAsk !== undefined) next.execAsk = p.execAsk;
        state.sessionSettings.set(key, next);
        state.persistAdapterState();
        const resolvedModel = await hermes.resolveHermesModel(next.model || config.HERMES_MODEL);
        const patch = {};
        if (typeof p.title === "string") patch.title = p.title;
        if (typeof p.displayName === "string") patch.title = p.displayName;
        if (typeof p.endReason === "string") patch.endReason = p.endReason;
        const agentId = resolveAgentIdFromSessionKey(key);
        if (isNativeSessionAgent(agentId) && Object.keys(patch).length > 0) {
          try {
            await hermes.patchNativeSession(hermesSessionIdForGatewayKey(key), patch);
          } catch (err) {
            if (!isNotFoundError(err)) logNativeSessionFallback(err);
          }
        }
        return resOk(id, {
          ok: true,
          key,
          entry: { thinkingLevel: next.thinkingLevel },
          resolved: { model: resolvedModel, modelProvider: "hermes" },
        });
      }

      case "sessions.reset": {
        const key = typeof p.key === "string" ? p.key : config.MAIN_SESSION_KEY;
        const agentId = resolveAgentIdFromSessionKey(key);
        if (isNativeSessionAgent(agentId)) {
          try {
            await hermes.deleteNativeSession(hermesSessionIdForGatewayKey(key));
          } catch (err) {
            if (!isNotFoundError(err)) logNativeSessionFallback(err);
          }
        }
        state.clearHistory(key);
        return resOk(id, { ok: true });
      }

      case "chat.send": {
        const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : config.MAIN_SESSION_KEY;
        const userMessage = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
        const runId = (typeof p.idempotencyKey === "string" && p.idempotencyKey) ? p.idempotencyKey : randomId();

        if (!userMessage) return resOk(id, { status: "no-op", runId });

        const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
        if (!state.agentRegistry.has(sessionAgentId) && profiles?.isConfigured?.()) {
          await resolveVisibleAgents();
        }
        const agent = state.agentRegistry.get(sessionAgentId);

        if (
          typeof p.idempotencyKey === "string" &&
          p.idempotencyKey.startsWith("skill-install:") &&
          userMessage.includes("Create these exact skill files inside the current workspace.")
        ) {
          if (!agent) {
            throw new Error(`Cannot install skill files because agent ${sessionAgentId} was not found.`);
          }
          const installResult = skills.writeSkillInstallerFiles(agent, userMessage);
          sendEvent({
            type: "event",
            event: "chat",
            payload: {
              runId,
              sessionKey,
              state: "final",
              stopReason: "end_turn",
              message: { role: "assistant", content: "INSTALLED" },
            },
          });
          return resOk(id, {
            status: "started",
            runId,
            installed: true,
            workspaceDir: installResult.workspaceDir,
            filesWritten: installResult.filesWritten,
          });
        }

        if (isNativeSessionAgent(sessionAgentId)) {
          return resOk(id, startNativeSessionChatRun({ sessionKey, userMessage, runId, sendEvent }));
        }

        return resOk(id, startChatRun({ sessionKey, userMessage, runId, sendEvent }));
      }

      case "chat.abort": {
        const runId = typeof p.runId === "string" ? p.runId.trim() : "";
        const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
        let aborted = 0;
        if (runId) {
          const handle = state.activeRuns.get(runId);
          if (handle) {
            handle.abort();
            state.activeRuns.delete(runId);
            aborted += 1;
          }
        } else if (sessionKey) {
          for (const [activeRunId, handle] of state.activeRuns.entries()) {
            if (handle.sessionKey !== sessionKey) continue;
            handle.abort();
            state.activeRuns.delete(activeRunId);
            aborted += 1;
          }
        }
        return resOk(id, { ok: true, aborted });
      }

      case "chat.history": {
        const histKey = typeof p.sessionKey === "string" ? p.sessionKey : config.MAIN_SESSION_KEY;
        try {
          const nativeMessages = await readNativeMessages(histKey);
          if (nativeMessages) {
            if (nativeMessages.length > 0) {
              state.conversationHistory.set(histKey, nativeMessages);
              state.saveHistoryToDisk();
            }
            return resOk(id, { sessionKey: histKey, messages: nativeMessages });
          }
        } catch (err) {
          logNativeSessionFallback(err);
        }
        return resOk(id, { sessionKey: histKey, messages: state.getHistory(histKey) });
      }

      case "agent.wait": {
        const { runId, timeoutMs = 30000 } = p;
        const start = Date.now();
        while (state.activeRuns.has(runId) && Date.now() - start < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return resOk(id, { status: state.activeRuns.has(runId) ? "running" : "done" });
      }

      case "exec.approvals.get":
        return resOk(id, {
          path: config.ADAPTER_STATE_FILE,
          exists: true,
          hash: state.computeExecApprovalsHash(),
          file: cloneJson(state.getExecApprovalsFile()),
          enforcement: STORED_ONLY_EXEC_ENFORCEMENT,
        });

      case "exec.approvals.set": {
        const currentHash = state.computeExecApprovalsHash();
        if (p.baseHash !== undefined && String(p.baseHash).trim() !== currentHash) {
          return resErr(id, "invalid_request", config.EXEC_APPROVALS_CHANGED_MESSAGE);
        }
        if (!utils.isPlainObject(p.file)) {
          return resErr(id, "invalid_request", "exec approvals file is required.");
        }
        state.replaceExecApprovalsFile(p.file);
        state.persistAdapterState();
        return resOk(id, {
          hash: state.computeExecApprovalsHash(),
          enforcement: STORED_ONLY_EXEC_ENFORCEMENT,
        });
      }

      case "exec.approval.resolve":
        return resOk(id, { ok: true, enforcement: STORED_ONLY_EXEC_ENFORCEMENT });

      case "status": {
        const recent = [...state.agentRegistry.keys()].flatMap((agentId) => {
          const sessionKey = `agent:${agentId}:${config.MAIN_KEY}`;
          const history = state.getHistory(sessionKey);
          return history.length > 0 ? [{ key: `agent:${agentId}:${config.MAIN_KEY}`, updatedAt: Date.now() }] : [];
        });
        return resOk(id, {
          sessions: {
            recent,
            byAgent: [...state.agentRegistry.keys()].map((agentId) => ({
              agentId,
              recent: recent.filter((entry) => entry.key.includes(`:${agentId}:`)),
            })),
          },
          heartbeat: { agents: buildHeartbeatStatusAgents() },
        });
      }

      case "wake": {
        const agentId = resolveWakeAgentId(p);
        if (!state.agentRegistry.has(agentId)) {
          return resErr(id, "not_found", `Agent not found: ${agentId}`);
        }
        return resOk(id, runHeartbeat({
          agentId,
          text: p.text,
          runId: `heartbeat:${agentId}:${randomId()}`,
          sendEvent,
        }));
      }

      case "skills.status": {
        const targetAgentId = typeof p.agentId === "string" && p.agentId.trim()
          ? p.agentId.trim()
          : config.AGENT_ID;
        const agent = state.agentRegistry.get(targetAgentId);
        if (!agent) {
          return resErr(id, "not_found", `Agent not found: ${targetAgentId}`);
        }
        return resOk(id, skills.buildSkillStatusReport(agent));
      }

      case "skills.install": {
        if (trimString(p.name) && trimString(p.installId)) {
          return resErr(id, "not_supported", "Hermes adapter cannot install external skill dependencies; packaged workspace skills are supported.");
        }
        const packageId = trimString(p.packageId);
        if (!packageId) {
          return resErr(id, "invalid_request", "packageId is required for Hermes packaged skill installs.");
        }
        const source = trimString(p.source) || "openclaw-workspace";
        if (source !== "openclaw-workspace") {
          return resErr(id, "not_supported", "Hermes adapter supports workspace packaged skill installs only.");
        }
        if (!skills.getPackagedSkillKey(packageId)) {
          return resErr(id, "not_found", `Unknown packaged skill: ${packageId}`);
        }
        const targetAgentId = trimString(p.agentId) || config.AGENT_ID;
        const agent = state.agentRegistry.get(targetAgentId);
        if (!agent) {
          return resErr(id, "not_found", `Agent not found: ${targetAgentId}`);
        }
        const requestedWorkspace = normalizePathString(p.workspaceDir);
        if (requestedWorkspace && requestedWorkspace !== normalizePathString(agent.workspace)) {
          return resErr(id, "invalid_request", `workspaceDir does not match agent workspace for ${targetAgentId}.`);
        }
        try {
          return resOk(id, skills.installPackagedSkill(agent, { packageId }));
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
      }

      case "skills.update": {
        const skillKey = typeof p.skillKey === "string" ? p.skillKey.trim() : "";
        if (!skillKey) {
          return resErr(id, "invalid_request", "skillKey is required.");
        }
        if (typeof p.enabled === "boolean") {
          state.skillEnabledByKey.set(skillKey, p.enabled);
          state.persistAdapterState();
        }
        const enabled = state.skillEnabledByKey.get(skillKey) !== false;
        return resOk(id, { ok: true, skillKey, config: { enabled } });
      }

      case "models.list":
        try {
          const models = await hermes.fetchHermesModels();
          return resOk(id, {
            models: (models.length > 0 ? models : [config.HERMES_MODEL]).map((modelId) => ({
              id: modelId,
              name: modelId,
            })),
          });
        } catch {
          return resOk(id, { models: [{ id: config.HERMES_MODEL, name: config.HERMES_MODEL }] });
        }

      case "usage.cost":
        return resOk(id, usage.buildCostUsage(p));

      case "tasks.list": {
        const includeArchived = p.includeArchived !== false;
        const tasks = sortTasks([...state.tasksById.values()])
          .filter((task) => includeArchived || !task.archived)
          .map((task) => cloneJson(task));
        return resOk(id, { tasks });
      }

      case "tasks.create": {
        let task;
        try {
          task = createTaskRecord(p);
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
        state.tasksById.set(task.id, task);
        state.persistAdapterState();
        return resOk(id, cloneJson(task));
      }

      case "tasks.update": {
        const taskId = trimString(p.id);
        if (!taskId) return resErr(id, "invalid_request", "Task id is required.");
        const existing = state.tasksById.get(taskId);
        if (!existing) return resErr(id, "not_found", `Task not found: ${taskId}`);
        let updated;
        try {
          updated = applyTaskPatch(existing, p);
        } catch (err) {
          return resErr(id, "invalid_request", sanitizeErrorMessage(err));
        }
        state.tasksById.set(taskId, updated);
        state.persistAdapterState();
        return resOk(id, cloneJson(updated));
      }

      case "tasks.delete": {
        const taskId = trimString(p.id);
        if (!taskId) return resErr(id, "invalid_request", "Task id is required.");
        const removed = state.tasksById.delete(taskId);
        if (removed) state.persistAdapterState();
        return resOk(id, { ok: true, removed });
      }

      case "cron.list": {
        const includeDisabled = p.includeDisabled !== false;
        const jobs = [...state.cronJobs.values()];
        return resOk(id, { jobs: includeDisabled ? jobs : jobs.filter((job) => job.enabled) });
      }

      case "cron.add": {
        const jobId = randomId();
        const agentId = typeof p.agentId === "string" && p.agentId.trim() ? p.agentId.trim() : config.AGENT_ID;
        const job = scheduler.withCronNextRun({
          id: jobId,
          name: typeof p.name === "string" ? p.name : "Cron Job",
          agentId,
          sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : `agent:${agentId}:${config.MAIN_KEY}`,
          description: typeof p.description === "string" ? p.description : "",
          enabled: p.enabled !== false,
          deleteAfterRun: Boolean(p.deleteAfterRun),
          updatedAtMs: Date.now(),
          schedule: p.schedule || { kind: "every", everyMs: 3600000 },
          sessionTarget: p.sessionTarget || "main",
          wakeMode: p.wakeMode || "next-heartbeat",
          payload: p.payload || { kind: "systemEvent", text: "tick" },
          state: {},
        });
        state.cronJobs.set(jobId, job);
        state.persistAdapterState();
        return resOk(id, job);
      }

      case "cron.remove": {
        const jobId = typeof p.id === "string" ? p.id : "";
        const removed = state.cronJobs.delete(jobId);
        if (removed) state.persistAdapterState();
        return resOk(id, { ok: true, removed });
      }

      case "cron.patch": {
        const jobId = typeof p.id === "string" ? p.id : "";
        const job = state.cronJobs.get(jobId);
        if (!job) return resOk(id, { ok: false, error: "not_found" });
        const updated = { ...job };
        if (p.enabled !== undefined) updated.enabled = Boolean(p.enabled);
        if (p.name !== undefined) updated.name = String(p.name);
        if (p.schedule !== undefined) updated.schedule = p.schedule;
        if (p.payload !== undefined) updated.payload = p.payload;
        if (p.state !== undefined && utils.isPlainObject(p.state)) updated.state = cloneJson(p.state);
        updated.updatedAtMs = Date.now();
        const normalized = scheduler.withCronNextRun(updated);
        state.cronJobs.set(jobId, normalized);
        state.persistAdapterState();
        return resOk(id, { ok: true, job: normalized });
      }

      case "cron.run": {
        const jobId = typeof p.id === "string" ? p.id : "";
        let job = state.cronJobs.get(jobId);
        if (!job) return resOk(id, { ok: false });
        job = scheduler.withCronNextRun(job);
        state.cronJobs.set(jobId, job);
        const mode = trimString(p.mode) || "force";
        if (mode === "auto") {
          const reason = scheduler.getCronAutoSkipReason(job);
          if (reason) {
            state.persistAdapterState();
            return resOk(id, { ok: true, ran: false, reason });
          }
        }
        const runId = `cron:${jobId}:${randomId()}`;
        const runningAtMs = Date.now();
        const running = { ...job, state: { ...(job.state || {}), runningAtMs } };
        state.cronJobs.set(jobId, running);
        state.persistAdapterState();
        sendEvent({
          type: "event",
          event: "cron",
          payload: { action: "started", jobId, runId, status: "running", summary: running },
        });
        sendEvent({
          type: "event",
          event: "playbook_triggered",
          payload: {
            taskId: `cron:${jobId}`,
            jobId,
            playbookJobId: jobId,
            agentId: running.agentId || config.AGENT_ID,
            runId,
            title: running.name || "Cron Job",
            status: "in_progress",
            occurredAt: new Date().toISOString(),
          },
        });
        startChatRun({
          sessionKey: job.sessionKey || `agent:${job.agentId || config.AGENT_ID}:${config.MAIN_KEY}`,
          userMessage: resolveCronPrompt(job),
          runId,
          sendEvent,
          onDone(outcome) {
            const current = state.cronJobs.get(jobId);
            if (!current) return;
            const currentState = current.state || {};
            const { runningAtMs: _runningAtMs, ...restState } = currentState;
            const lastStatus = outcome.status === "ok" ? "ok" : (outcome.status === "aborted" ? "skipped" : "error");
            const nextState = {
              ...restState,
              lastRunAtMs: Date.now(),
              lastStatus,
              lastDurationMs: outcome.durationMs,
            };
            if (outcome.errorMessage) nextState.lastError = outcome.errorMessage;
            else delete nextState.lastError;
            const done = { ...current, state: nextState };
            const normalizedDone = lastStatus === "ok" ? scheduler.withCronNextRun(done) : done;
            if (lastStatus === "ok" && current.deleteAfterRun) {
              state.cronJobs.delete(jobId);
            } else {
              state.cronJobs.set(jobId, normalizedDone);
            }
            state.persistAdapterState();
            sendEvent({
              type: "event",
              event: "cron",
              payload: { action: "finished", jobId, runId, status: lastStatus, summary: normalizedDone },
            });
            sendEvent({
              type: "event",
              event: "task_status_changed",
              payload: {
                taskId: `cron:${jobId}`,
                jobId,
                playbookJobId: jobId,
                agentId: normalizedDone.agentId || config.AGENT_ID,
                runId,
                title: normalizedDone.name || "Cron Job",
                status: lastStatus === "ok" ? "review" : (lastStatus === "skipped" ? "blocked" : "blocked"),
                occurredAt: new Date().toISOString(),
              },
            });
          },
        });
        return resOk(id, { ok: true, ran: true, runId });
      }

      default:
        console.warn(`[hermes-adapter] Unhandled method: ${method}`);
        return resOk(id, {});
    }
  };
}

module.exports = { createHandleMethod };
