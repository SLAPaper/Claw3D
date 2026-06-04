"use strict";

const path = require("path");

function createOrchestration(ctx) {
  const { config, state, hermes, utils, events } = ctx;
  const { randomId, sanitizeErrorMessage } = utils;

  const TEAM_TOOLS = [
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description: "Create a new sub-agent team member. Returns the agent's ID.",
        parameters: {
          type: "object",
          required: ["name", "role"],
          properties: {
            name: { type: "string", description: "Display name, e.g. 'Backend Dev'" },
            role: { type: "string", description: "Short role description, e.g. 'Python backend specialist'" },
            instructions: { type: "string", description: "System prompt / instructions for this agent" },
            wipe: { type: "boolean", description: "Clear history before each run (stateless). Default false." },
            continuity: { type: "boolean", description: "Maintain full conversation history. Default true." },
            boundaries: { type: "string", description: "Hard constraints on what this agent may do" },
            model: { type: "string", description: "Model to use. Defaults to hermes." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delegate_task",
        description: "Send a task or question to a specific team member and get their response.",
        parameters: {
          type: "object",
          required: ["agent_id", "message"],
          properties: {
            agent_id: { type: "string", description: "ID returned by spawn_agent" },
            message: { type: "string", description: "The task, question, or instructions to send" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_team",
        description: "List all current team members with their IDs, names, and roles.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "configure_agent",
        description: "Update an existing agent's name, role/title, instructions, or settings.",
        parameters: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string" },
            name: { type: "string" },
            role: { type: "string", description: "Short role or title shown as subtitle below the agent name in the office (e.g. 'Marketing Chef', 'Code Reviewer')." },
            instructions: { type: "string" },
            wipe: { type: "boolean" },
            continuity: { type: "boolean" },
            boundaries: { type: "string" },
            model: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "dismiss_agent",
        description: "Remove an agent from the team.",
        parameters: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_agent_context",
        description: "Read the recent conversation history of another agent to understand what they are working on, what they have already done, or what their current status is. Useful for coordination and avoiding duplicate work.",
        parameters: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string", description: "ID of the agent whose context you want to read" },
            last_n: { type: "number", description: "How many recent messages to return (default 10, max 40)" },
          },
        },
      },
    },
  ];

  async function execSpawnAgent(args) {
    const name = (typeof args.name === "string" ? args.name : "Agent").trim() || "Agent";
    const role = (typeof args.role === "string" ? args.role : "").trim();
    const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
    const boundaries = typeof args.boundaries === "string" ? args.boundaries.trim() : "";
    const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : config.HERMES_MODEL;
    const wipe = Boolean(args.wipe);
    const continuity = args.continuity !== false;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const newId = `${slug}-${randomId().slice(0, 6)}`;

    let systemPrompt = instructions || `You are ${name}, a ${role || "specialist"} agent.`;
    if (boundaries) systemPrompt += `\n\nBoundaries: ${boundaries}`;

    const agent = {
      id: newId,
      name,
      workspace: path.join(config.HOME, ".hermes", `workspace-${slug}`),
      role,
      systemPrompt,
      settings: { wipe, continuity, model, boundaries },
    };
    state.agentRegistry.set(newId, agent);
    state.upsertConfigAgent(agent);
    state.persistAdapterState();

    console.log(`[hermes-adapter] Spawned agent: ${name} (${newId})`);
    events.broadcastEvent({
      type: "event",
      event: "presence",
      payload: {
        sessions: {
          recent: [],
          byAgent: [...state.agentRegistry.keys()].map((aid) => ({
            agentId: aid,
            recent: [],
          })),
        },
      },
    });

    return JSON.stringify({ ok: true, agent_id: newId, name, role });
  }

  async function execDelegateTask(args) {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!targetId || !message) return JSON.stringify({ ok: false, error: "agent_id and message required" });

    const agent = state.agentRegistry.get(targetId);
    if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });

    const sessionKey = `agent:${targetId}:${config.MAIN_KEY}`;
    const history = state.getHistory(sessionKey);
    const model = agent.settings.model || config.HERMES_MODEL;
    const systemMsg = agent.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : [];
    const contextHistory = agent.settings.wipe ? [] : [...history];
    const messages = [...systemMsg, ...contextHistory, { role: "user", content: message }];

    const subRunId = randomId();
    let seqCounter = 0;
    const emitSub = (stateName, extra) => {
      events.broadcastEvent({
        type: "event",
        event: "chat",
        seq: seqCounter++,
        payload: { runId: subRunId, sessionKey, state: stateName, ...extra },
      });
    };

    emitSub("delta", { message: { role: "assistant", content: "…" } });

    let responseText = "";
    try {
      const result = await hermes.streamOneTurn(messages, model, [], (partial) => {
        responseText = partial;
        emitSub("delta", { message: { role: "assistant", content: partial } });
      }, null);
      responseText = result.textContent;

      if (agent.settings.continuity !== false) {
        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: responseText });
        state.saveHistoryToDisk();
      }

      emitSub("final", { stopReason: "end_turn", message: { role: "assistant", content: responseText } });
      events.broadcastEvent({
        type: "event",
        event: "presence",
        payload: {
          sessions: {
            recent: [{ key: sessionKey, updatedAt: Date.now() }],
            byAgent: [{ agentId: targetId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
          },
        },
      });
    } catch (err) {
      const messageText = sanitizeErrorMessage(err);
      emitSub("error", { errorMessage: messageText });
      return JSON.stringify({ ok: false, error: messageText });
    }

    return JSON.stringify({ ok: true, agent_id: targetId, response: responseText });
  }

  function execListTeam() {
    const members = [...state.agentRegistry.values()].map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role || "",
      settings: agent.settings,
    }));
    return JSON.stringify({ team: members });
  }

  function execConfigureAgent(args) {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    const agent = state.agentRegistry.get(targetId);
    if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
    if (typeof args.name === "string" && args.name.trim()) agent.name = args.name.trim();
    if (typeof args.role === "string") agent.role = args.role.trim();
    if (typeof args.instructions === "string") agent.systemPrompt = args.instructions;
    if (typeof args.wipe === "boolean") agent.settings.wipe = args.wipe;
    if (typeof args.continuity === "boolean") agent.settings.continuity = args.continuity;
    if (typeof args.boundaries === "string") {
      agent.settings.boundaries = args.boundaries;
      if (agent.systemPrompt && args.boundaries) {
        agent.systemPrompt = agent.systemPrompt.replace(/\n\nBoundaries:.*$/s, "") + `\n\nBoundaries: ${args.boundaries}`;
      }
    }
    if (typeof args.model === "string" && args.model.trim()) agent.settings.model = args.model.trim();
    console.log(`[hermes-adapter] Configured agent: ${agent.name} (${targetId})`);
    state.upsertConfigAgent(agent);
    state.persistAdapterState();
    events.broadcastEvent({
      type: "event",
      event: "presence",
      payload: {
        sessions: {
          recent: [],
          byAgent: [...state.agentRegistry.keys()].map((aid) => ({
            agentId: aid,
            recent: [],
          })),
        },
      },
    });
    return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, role: agent.role, settings: agent.settings });
  }

  function execDismissAgent(args) {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    if (!targetId || targetId === config.AGENT_ID) return JSON.stringify({ ok: false, error: "Cannot dismiss the main orchestrator." });
    const agent = state.agentRegistry.get(targetId);
    if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
    state.agentRegistry.delete(targetId);
    state.removeConfigAgent(targetId);
    state.persistAdapterState();
    state.clearHistory(`agent:${targetId}:${config.MAIN_KEY}`);
    console.log(`[hermes-adapter] Dismissed agent: ${agent.name} (${targetId})`);
    return JSON.stringify({ ok: true, dismissed: targetId });
  }

  function execReadAgentContext(args) {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    const agent = state.agentRegistry.get(targetId);
    if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
    const lastN = Math.min(Math.max(Number(args.last_n) || 10, 1), 40);
    const sessionKey = `agent:${targetId}:${config.MAIN_KEY}`;
    const recent = state.getHistory(sessionKey).slice(-lastN);
    return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, recent });
  }

  async function executeToolCall(tc, sendEvent) {
    switch (tc.name) {
      case "spawn_agent":          return execSpawnAgent(tc.args, sendEvent);
      case "delegate_task":        return execDelegateTask(tc.args, sendEvent);
      case "list_team":            return execListTeam();
      case "configure_agent":      return execConfigureAgent(tc.args);
      case "dismiss_agent":        return execDismissAgent(tc.args);
      case "read_agent_context":   return execReadAgentContext(tc.args);
      default:                     return JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}` });
    }
  }

  async function runAgenticLoop({ sessionKey, agentId, userMessage, model, tools, emitDelta, abortCheck, sendEvent }) {
    const agent = state.agentRegistry.get(agentId);
    const systemMsg = agent?.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : [];
    const history = state.getHistory(sessionKey);
    const contextHistory = agent?.settings?.wipe ? [] : [...history];
    let messages = [...systemMsg, ...contextHistory, { role: "user", content: userMessage }];

    let finalText = "";
    let round = 0;

    while (round < config.MAX_TOOL_ROUNDS) {
      round++;
      const { textContent, toolCalls, finishReason } = await hermes.streamOneTurn(
        messages,
        model,
        tools,
        emitDelta,
        abortCheck
      );

      if (finishReason === "tool_calls" && toolCalls.length > 0) {
        const toolNames = toolCalls.map((toolCall) => toolCall.name).join(", ");
        const statusText = textContent || `Executing: ${toolNames}…`;
        if (statusText) emitDelta(statusText);

        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
          })),
        });

        const toolResults = await Promise.all(
          toolCalls.map(async (toolCall) => {
            const result = await executeToolCall(toolCall, sendEvent);
            return { role: "tool", tool_call_id: toolCall.id, content: result };
          })
        );
        messages.push(...toolResults);
        continue;
      }

      finalText = textContent;
      break;
    }

    if (agent?.settings?.continuity !== false) {
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: finalText });
      state.saveHistoryToDisk();
    }

    return finalText;
  }

  return {
    TEAM_TOOLS,
    execSpawnAgent,
    execDelegateTask,
    execListTeam,
    execConfigureAgent,
    execDismissAgent,
    execReadAgentContext,
    executeToolCall,
    runAgenticLoop,
  };
}

module.exports = { createOrchestration };
