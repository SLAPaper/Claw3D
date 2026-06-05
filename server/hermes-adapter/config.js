"use strict";

const fs = require("fs");
const path = require("path");

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadRuntimeEnv() {
  const cwd = process.cwd();
  loadDotenvFile(path.join(cwd, ".env.local"));
  loadDotenvFile(path.join(cwd, ".env"));
}

function createConfig() {
  loadRuntimeEnv();

  const HERMES_API_URL = (process.env.HERMES_API_URL || "http://localhost:8642").replace(/\/$/, "");
  const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
  const ADAPTER_PORT = parseInt(process.env.HERMES_ADAPTER_PORT || "18789", 10);
  const HERMES_MODEL = process.env.HERMES_MODEL || "hermes";
  const HERMES_AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
  const HOME = process.env.HOME || "/tmp";
  const HERMES_ADAPTER_STATE_DIR = (process.env.HERMES_ADAPTER_STATE_DIR || "").trim()
    || path.join(HOME, ".hermes");

  const AGENT_ID = "hermes";
  const MAIN_KEY = "main";
  const MAIN_SESSION_KEY = `agent:${AGENT_ID}:${MAIN_KEY}`;
  const CONFIG_PATH = path.join(HOME, ".hermes", "config.json");
  const ADAPTER_STATE_SCHEMA_VERSION = 1;
  const ADAPTER_STATE_FILE = path.join(HERMES_ADAPTER_STATE_DIR, "claw3d-adapter-state.json");
  const MANAGED_SKILLS_DIR = path.join(HOME, ".hermes", "skills");
  const HISTORY_FILE = path.join(HOME, ".hermes", "clawd3d-history.json");
  const MAX_TOOL_ROUNDS = 8;
  const CONFIG_CHANGED_MESSAGE = "config changed since last load; re-run config.get and retry";
  const EXEC_APPROVALS_CHANGED_MESSAGE = "exec approvals changed since last load; re-run exec.approvals.get and retry";

  const ORCHESTRATOR_SYSTEM_PROMPT = `You are ${HERMES_AGENT_NAME}, an AI orchestrator managing a team of sub-agents in a virtual 3D office.

You have tools to build and manage your team autonomously:

- **spawn_agent**: Create a new specialist agent with a name, role, instructions, and settings (wipe/continuity/boundaries).
- **delegate_task**: Send a task to a specific agent and receive their response.
- **list_team**: See all current team members and their IDs, names, and roles.
- **configure_agent**: Update an agent's name, role/title, instructions, or settings.
- **dismiss_agent**: Remove an agent from the team.
- **read_agent_context**: Read the recent conversation history of another agent to understand what they are currently working on, what they have already done, or what their status is. Use this for coordination — before delegating a task, check if the agent already has relevant context.

When given a goal:
1. Analyse what specialist roles are needed.
2. spawn_agent for each specialist.
3. delegate_task to assign work and coordinate.
4. Use read_agent_context to check what an agent has done or is doing before re-delegating.
5. Synthesise results into a final answer for the user.

Each spawned agent will appear as an animated character in the 3D office — walking when active, standing when idle.
Be concise in your responses to the user; do the heavy lifting via tool calls.`;

  return {
    HERMES_API_URL,
    HERMES_API_KEY,
    ADAPTER_PORT,
    HERMES_MODEL,
    HERMES_AGENT_NAME,
    HOME,
    HERMES_ADAPTER_STATE_DIR,
    AGENT_ID,
    MAIN_KEY,
    MAIN_SESSION_KEY,
    CONFIG_PATH,
    ADAPTER_STATE_SCHEMA_VERSION,
    ADAPTER_STATE_FILE,
    MANAGED_SKILLS_DIR,
    HISTORY_FILE,
    MAX_TOOL_ROUNDS,
    CONFIG_CHANGED_MESSAGE,
    EXEC_APPROVALS_CHANGED_MESSAGE,
    ORCHESTRATOR_SYSTEM_PROMPT,
  };
}

module.exports = { createConfig };
