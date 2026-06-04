"use strict";

function createHandleMethod(ctx) {
  const { config, state, workspaceFiles, hermes, skills, orchestration, events, utils } = ctx;
  const {
    cloneJson,
    randomId,
    resolveAgentIdFromSessionKey,
    sanitizeErrorMessage,
    resOk,
    resErr,
  } = utils;

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
        const sessions = [...state.agentRegistry.values()].map((agent) => {
          const sessionKey = `agent:${agent.id}:${config.MAIN_KEY}`;
          const history = state.getHistory(sessionKey);
          const settings = state.sessionSettings.get(sessionKey) || {};
          return {
            key: sessionKey,
            agentId: agent.id,
            updatedAt: history.length > 0 ? Date.now() : null,
            displayName: "Main",
            origin: { label: agent.name, provider: "hermes" },
            model: settings.model || agent.settings?.model || config.HERMES_MODEL,
            modelProvider: "hermes",
          };
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
        const isOrchestrator = sessionAgentId === config.AGENT_ID;

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

        let aborted = false;
        state.activeRuns.set(runId, {
          runId,
          sessionKey,
          agentId: sessionAgentId,
          abort() { aborted = true; },
        });

        setImmediate(async () => {
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
              userMessage,
              model,
              tools,
              emitDelta: onTextDelta,
              abortCheck: () => aborted,
              sendEvent,
            });

            if (aborted) {
              emitChat("aborted", {});
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
            }
          } catch (err) {
            if (!aborted) emitChat("error", { errorMessage: sanitizeErrorMessage(err) || "Hermes API error" });
            else emitChat("aborted", {});
          } finally {
            state.activeRuns.delete(runId);
          }
        });

        return resOk(id, { status: "started", runId });
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
          path: "",
          exists: true,
          hash: "hermes-approvals",
          file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} },
        });

      case "exec.approvals.set":
        return resOk(id, { hash: "hermes-approvals" });

      case "exec.approval.resolve":
        return resOk(id, { ok: true });

      case "status": {
        const recent = [...state.agentRegistry.keys()].flatMap((agentId) => {
          const history = state.getHistory(`agent:${agentId}:${config.MAIN_KEY}`);
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
        });
      }

      case "wake":
        return resOk(id, { ok: true });

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

      case "tasks.list":
        return resOk(id, { tasks: [] });

      case "cron.list": {
        const includeDisabled = p.includeDisabled !== false;
        const jobs = [...state.cronJobs.values()];
        return resOk(id, { jobs: includeDisabled ? jobs : jobs.filter((job) => job.enabled) });
      }

      case "cron.add": {
        const jobId = randomId();
        const job = {
          id: jobId,
          name: typeof p.name === "string" ? p.name : "Cron Job",
          agentId: typeof p.agentId === "string" ? p.agentId : config.AGENT_ID,
          sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : config.MAIN_SESSION_KEY,
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
        state.cronJobs.set(jobId, { ...job, state: { ...job.state, runningAtMs: Date.now() } });
        state.persistAdapterState();
        setTimeout(() => {
          const current = state.cronJobs.get(jobId);
          if (!current) return;
          const done = {
            ...current,
            state: { ...current.state, runningAtMs: undefined, lastRunAtMs: Date.now(), lastStatus: "ok" },
          };
          state.cronJobs.set(jobId, done);
          state.persistAdapterState();
          events.broadcastEvent({ type: "event", event: "cron", payload: { action: "finished", jobId, status: "ok", summary: done } });
        }, 3000);
        return resOk(id, { ok: true, ran: true });
      }

      default:
        console.warn(`[hermes-adapter] Unhandled method: ${method}`);
        return resOk(id, {});
    }
  };
}

module.exports = { createHandleMethod };
