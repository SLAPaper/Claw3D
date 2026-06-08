"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const SHELL_ENV_KEYS = new Set(Object.keys(process.env));
const RUNTIME_ENV_KEYS = new Set();
const WATCHED_ENV_FILES = [".env", ".env.local"];

function loadRuntimeEnv() {
  const cwd = process.cwd();
  const envPath = path.join(cwd, ".env");
  const envLocalPath = path.join(cwd, ".env.local");

  const merged = {};
  if (fs.existsSync(envPath)) {
    Object.assign(merged, dotenv.parse(fs.readFileSync(envPath, "utf8")));
  }
  if (fs.existsSync(envLocalPath)) {
    Object.assign(merged, dotenv.parse(fs.readFileSync(envLocalPath, "utf8")));
  }

  // Remove previously injected runtime env keys so deleted entries are reflected.
  for (const key of RUNTIME_ENV_KEYS) {
    if (!SHELL_ENV_KEYS.has(key)) delete process.env[key];
  }
  RUNTIME_ENV_KEYS.clear();

  // Keep shell-provided variables as highest priority, same as Next dev behavior.
  for (const [key, value] of Object.entries(merged)) {
    if (SHELL_ENV_KEYS.has(key)) continue;
    process.env[key] = String(value);
    RUNTIME_ENV_KEYS.add(key);
  }
}

function readConfigFromProcessEnv() {
  const HOME = process.env.HOME || "/tmp";
  const HERMES_AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
  const HERMES_DASHBOARD_SESSION_TOKEN = (process.env.HERMES_DASHBOARD_SESSION_TOKEN || "").trim();
  const HERMES_PROFILE_API_TOKEN = (
    process.env.HERMES_PROFILE_API_TOKEN || HERMES_DASHBOARD_SESSION_TOKEN
  ).trim();

  const AGENT_ID = "hermes";
  const MAIN_KEY = "main";
  const HERMES_ADAPTER_STATE_DIR = (process.env.HERMES_ADAPTER_STATE_DIR || "").trim()
    || path.join(HOME, ".hermes");

  return {
    HERMES_API_URL: (process.env.HERMES_API_URL || "http://localhost:8642").replace(/\/$/, ""),
    HERMES_API_KEY: process.env.HERMES_API_KEY || "",
    HERMES_PROFILE_API_URL: (process.env.HERMES_PROFILE_API_URL || "").trim().replace(/\/$/, ""),
    HERMES_PROFILE_API_TOKEN,
    HERMES_DASHBOARD_SESSION_TOKEN,
    ADAPTER_PORT: parseInt(process.env.HERMES_ADAPTER_PORT || "18789", 10),
    HERMES_MODEL: process.env.HERMES_MODEL || "hermes",
    HERMES_AGENT_NAME,
    HOME,
    HERMES_ADAPTER_STATE_DIR,
    AGENT_ID,
    MAIN_KEY,
    MAIN_SESSION_KEY: `agent:${AGENT_ID}:${MAIN_KEY}`,
    CONFIG_PATH: path.join(HOME, ".hermes", "config.json"),
    ADAPTER_STATE_SCHEMA_VERSION: 1,
    ADAPTER_STATE_FILE: path.join(HERMES_ADAPTER_STATE_DIR, "claw3d-adapter-state.json"),
    MANAGED_SKILLS_DIR: path.join(HOME, ".hermes", "skills"),
    HISTORY_FILE: path.join(HOME, ".hermes", "clawd3d-history.json"),
    MAX_TOOL_ROUNDS: 8,
    CONFIG_CHANGED_MESSAGE: "config changed since last load; re-run config.get and retry",
    EXEC_APPROVALS_CHANGED_MESSAGE: "exec approvals changed since last load; re-run exec.approvals.get and retry",
    ORCHESTRATOR_SYSTEM_PROMPT: `You are ${HERMES_AGENT_NAME}, an AI orchestrator managing a team of sub-agents in a virtual 3D office.

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
Be concise in your responses to the user; do the heavy lifting via tool calls.`,
  };
}

function reloadConfigFromEnv(config) {
  loadRuntimeEnv();
  const nextConfig = readConfigFromProcessEnv();
  const changedKeys = [];
  for (const [key, value] of Object.entries(nextConfig)) {
    if (config[key] !== value) changedKeys.push(key);
  }
  Object.assign(config, nextConfig);
  return { changedKeys };
}

function startEnvReloadWatcher(config, options = {}) {
  const cwd = process.cwd();
  const onReload = typeof options.onReload === "function" ? options.onReload : null;
  const watchPaths = WATCHED_ENV_FILES.map((name) => path.join(cwd, name));

  let timer = null;
  let pendingFilePath = null;

  const triggerReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const previousPort = config.ADAPTER_PORT;
      const { changedKeys } = reloadConfigFromEnv(config);
      if (onReload) {
        onReload({
          envFilePath: pendingFilePath ? path.basename(pendingFilePath) : null,
          changedKeys,
          previousPort,
          currentPort: config.ADAPTER_PORT,
        });
      }
      pendingFilePath = null;
    }, 150);
  };

  for (const filePath of watchPaths) {
    fs.watchFile(filePath, { interval: 250 }, (curr, prev) => {
      if (
        curr.mtimeMs === prev.mtimeMs
        && curr.size === prev.size
        && curr.ctimeMs === prev.ctimeMs
      ) {
        return;
      }
      pendingFilePath = filePath;
      triggerReload();
    });
  }

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const filePath of watchPaths) {
      fs.unwatchFile(filePath);
    }
  };
}

function createConfig() {
  loadRuntimeEnv();
  return readConfigFromProcessEnv();
}

module.exports = { createConfig, reloadConfigFromEnv, startEnvReloadWatcher };
