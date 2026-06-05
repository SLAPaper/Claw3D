"use strict";

function createHandleMethod(ctx) {
  const { config, state, workspaceFiles, hermes, skills, orchestration, utils } = ctx;
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
    const adapterConfig = state.getAdapterConfig();
    const agents = utils.isPlainObject(adapterConfig.agents) ? adapterConfig.agents : {};
    const defaults = utils.isPlainObject(agents.defaults) && utils.isPlainObject(agents.defaults.heartbeat)
      ? agents.defaults.heartbeat
      : {};
    const agentEntry = state.getConfigAgentList(adapterConfig).find((entry) => entry.id === agentId) || {};
    const override = utils.isPlainObject(agentEntry.heartbeat) ? agentEntry.heartbeat : {};
    const merged = { ...defaults, ...override };
    const every = trimString(merged.every);
    const loweredEvery = every.toLowerCase();
    const enabled = Boolean(every && loweredEvery !== "disabled" && loweredEvery !== "off" && loweredEvery !== "none");
    return {
      agentId,
      enabled,
      ...(every ? { every } : {}),
    };
  }

  function buildHeartbeatStatusAgents() {
    return [...state.agentRegistry.keys()].map((agentId) => resolveHeartbeatBlock(agentId));
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

  return async function handleMethod(method, params, id, sendEvent) {
    const p = params || {};

    switch (method) {
      case "agents.list": {
        const allAgents = [...state.agentRegistry.values()].map((agent) => ({
          id: agent.id,
          name: agent.name,
          workspace: agent.workspace,
          identity: { name: agent.name, emoji: "🤖" },
          role: agent.role,
        }));
        return resOk(id, { defaultId: config.AGENT_ID, mainKey: config.MAIN_KEY, agents: allAgents });
      }

      case "agents.create": {
        const agentName = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Agent";
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

      case "config.get":
        return resOk(id, {
          config: cloneJson(state.getAdapterConfig()),
          hash: state.computeConfigHash(),
          exists: true,
          path: config.CONFIG_PATH,
        });

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
        const sessions = [...sessionKeys].map((sessionKey) => {
          const agentId = resolveAgentIdFromSessionKey(sessionKey);
          return buildSessionEntry(sessionKey, state.agentRegistry.get(agentId));
        });
        return resOk(id, { sessions });
      }

      case "sessions.preview": {
        const keys = Array.isArray(p.keys) ? p.keys : [];
        const limit = typeof p.limit === "number" ? p.limit : 8;
        const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
        const previews = keys.map((key) => {
          const history = state.getHistory(key);
          if (history.length === 0) return { key, status: "empty", items: [] };
          const items = history.slice(-limit).map((msg) => ({
            role: msg.role === "assistant" ? "assistant" : "user",
            text: String(msg.content || "").slice(0, maxChars),
            timestamp: Date.now(),
          }));
          return { key, status: "ok", items };
        });
        return resOk(id, { ts: Date.now(), previews });
      }

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
        return resOk(id, {
          ok: true,
          key,
          entry: { thinkingLevel: next.thinkingLevel },
          resolved: { model: resolvedModel, modelProvider: "hermes" },
        });
      }

      case "sessions.reset": {
        const key = typeof p.key === "string" ? p.key : config.MAIN_SESSION_KEY;
        state.clearHistory(key);
        return resOk(id, { ok: true });
      }

      case "chat.send": {
        const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : config.MAIN_SESSION_KEY;
        const userMessage = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
        const runId = (typeof p.idempotencyKey === "string" && p.idempotencyKey) ? p.idempotencyKey : randomId();

        if (!userMessage) return resOk(id, { status: "no-op", runId });

        const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
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
        const sessionKey = `agent:${agentId}:heartbeat`;
        const runId = `heartbeat:${agentId}:${randomId()}`;
        const text = trimString(p.text) || `Claw3D heartbeat trigger (${agentId}).`;
        sendEvent({
          type: "event",
          event: "heartbeat",
          payload: { action: "started", agentId, sessionKey, runId, text, timestamp: Date.now() },
        });
        const result = startChatRun({ sessionKey, userMessage: text, runId, sendEvent });
        return resOk(id, { ok: result.status !== "no-op", runId });
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
        const job = {
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
        };
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
        updated.updatedAtMs = Date.now();
        state.cronJobs.set(jobId, updated);
        state.persistAdapterState();
        return resOk(id, { ok: true, job: updated });
      }

      case "cron.run": {
        const jobId = typeof p.id === "string" ? p.id : "";
        const job = state.cronJobs.get(jobId);
        if (!job) return resOk(id, { ok: false });
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
            state.cronJobs.set(jobId, done);
            state.persistAdapterState();
            sendEvent({
              type: "event",
              event: "cron",
              payload: { action: "finished", jobId, runId, status: lastStatus, summary: done },
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
