"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createState(config, utils) {
  const {
    cloneJson,
    isPlainObject,
    sanitizeErrorMessage,
    slugifyName,
    stableStringify,
  } = utils;

  /** @type {Map<string, Array<{role: string, content: string}>>} */
  const conversationHistory = new Map();
  /** @type {Map<string, {model?: string, thinkingLevel?: string}>} */
  const sessionSettings = new Map();
  /** @type {Map<string, boolean>} skillKey -> enabled */
  const skillEnabledByKey = new Map();
  /** @type {Map<string, {runId: string, sessionKey: string, agentId: string, abort: () => void}>} */
  const activeRuns = new Map();
  /** @type {Map<string, object>} jobId -> CronJobSummary */
  const cronJobs = new Map();
  /** @type {Map<string, object>} taskId -> GatewayTaskRecord */
  const tasksById = new Map();
  /** @type {Map<string, object>} agentId -> heartbeat scheduler state */
  const heartbeatStateByAgentId = new Map();

  let persistDebounceTimer = null;

  function createDefaultAgent() {
    return {
      id: config.AGENT_ID,
      name: config.HERMES_AGENT_NAME,
      workspace: path.join(config.HOME, ".hermes", "workspace-hermes"),
      role: "Orchestrator",
      systemPrompt: config.ORCHESTRATOR_SYSTEM_PROMPT,
      settings: { wipe: false, continuity: true, model: config.HERMES_MODEL },
    };
  }

  function normalizeAgentSettings(rawSettings, fallbackSettings, rawAgent) {
    const fallback = isPlainObject(fallbackSettings)
      ? fallbackSettings
      : { wipe: false, continuity: true, model: config.HERMES_MODEL };
    const source = isPlainObject(rawSettings) ? rawSettings : {};
    const settings = { ...fallback, ...source };
    if (typeof rawAgent?.model === "string" && rawAgent.model.trim()) {
      settings.model = rawAgent.model.trim();
    }
    if (typeof rawAgent?.wipe === "boolean") settings.wipe = rawAgent.wipe;
    if (typeof rawAgent?.continuity === "boolean") settings.continuity = rawAgent.continuity;
    if (typeof rawAgent?.boundaries === "string") settings.boundaries = rawAgent.boundaries;
    settings.wipe = Boolean(settings.wipe);
    settings.continuity = settings.continuity !== false;
    if (typeof settings.model !== "string" || !settings.model.trim()) {
      settings.model = config.HERMES_MODEL;
    } else {
      settings.model = settings.model.trim();
    }
    return settings;
  }

  function normalizeAgentRecord(rawAgent, fallbackAgent) {
    const raw = isPlainObject(rawAgent) ? rawAgent : {};
    const fallback = isPlainObject(fallbackAgent) ? fallbackAgent : {};
    const id = typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : (typeof fallback.id === "string" && fallback.id.trim() ? fallback.id.trim() : config.AGENT_ID);
    const fallbackName = typeof fallback.name === "string" && fallback.name.trim()
      ? fallback.name.trim()
      : (id === config.AGENT_ID ? config.HERMES_AGENT_NAME : "Agent");
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
    const workspace = typeof raw.workspace === "string" && raw.workspace.trim()
      ? raw.workspace.trim()
      : (typeof fallback.workspace === "string" && fallback.workspace.trim()
        ? fallback.workspace.trim()
        : path.join(config.HOME, ".hermes", `workspace-${slugifyName(name)}`));
    const role = typeof raw.role === "string"
      ? raw.role.trim()
      : (typeof fallback.role === "string" ? fallback.role : (id === config.AGENT_ID ? "Orchestrator" : ""));
    const systemPrompt = typeof raw.systemPrompt === "string"
      ? raw.systemPrompt
      : (typeof raw.instructions === "string"
        ? raw.instructions
        : (typeof fallback.systemPrompt === "string"
          ? fallback.systemPrompt
          : (id === config.AGENT_ID ? config.ORCHESTRATOR_SYSTEM_PROMPT : `You are ${name}.`)));
    const settings = normalizeAgentSettings(raw.settings, fallback.settings, raw);
    return { id, name, workspace, role, systemPrompt, settings };
  }

  function agentToConfigEntry(agent) {
    const entry = {
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
    };
    if (agent.role) entry.role = agent.role;
    if (agent.settings?.model) entry.model = agent.settings.model;
    if (agent.settings) entry.settings = cloneJson(agent.settings);
    return entry;
  }

  function createDefaultConfig() {
    return {
      gateway: { reload: { mode: "hot" } },
      agents: { list: [agentToConfigEntry(createDefaultAgent())] },
    };
  }

  function createDefaultExecApprovalsFile() {
    return {
      version: 1,
      defaults: { security: "full", ask: "off", autoAllowSkills: true },
      agents: {},
    };
  }

  let adapterConfig = createDefaultConfig();
  let execApprovalsFile = createDefaultExecApprovalsFile();
  const agentRegistry = new Map([[config.AGENT_ID, createDefaultAgent()]]);
  let historyLoadedFromDisk = false;

  function getConfigAgentList(sourceConfig = adapterConfig) {
    const agents = isPlainObject(sourceConfig?.agents) ? sourceConfig.agents : {};
    return Array.isArray(agents.list) ? agents.list.filter(isPlainObject) : [];
  }

  function setConfigAgentList(list) {
    const currentAgents = isPlainObject(adapterConfig.agents) ? adapterConfig.agents : {};
    adapterConfig = { ...adapterConfig, agents: { ...currentAgents, list } };
  }

  function upsertConfigAgent(agent) {
    const list = getConfigAgentList().map((entry) => ({ ...entry }));
    const index = list.findIndex((entry) => entry.id === agent.id);
    const nextEntry = agentToConfigEntry(agent);
    if (index >= 0) {
      list[index] = { ...list[index], ...nextEntry };
    } else {
      list.push(nextEntry);
    }
    setConfigAgentList(list);
  }

  function removeConfigAgent(agentId) {
    if (!agentId) return;
    setConfigAgentList(getConfigAgentList().filter((entry) => entry.id !== agentId));
  }

  function reconcileAgentRegistryFromConfig(options = {}) {
    const agentsBlock = isPlainObject(adapterConfig.agents) ? adapterConfig.agents : {};
    const hasConfigList = Array.isArray(agentsBlock.list);
    const configAgents = hasConfigList ? getConfigAgentList() : [];
    const configuredIds = new Set();

    for (const entry of configAgents) {
      const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!entryId) continue;
      configuredIds.add(entryId);
      const fallback = agentRegistry.get(entryId) || (entryId === config.AGENT_ID ? createDefaultAgent() : undefined);
      agentRegistry.set(entryId, normalizeAgentRecord({ ...entry, id: entryId }, fallback));
    }

    if (options.pruneNonDefault) {
      for (const agentId of [...agentRegistry.keys()]) {
        if (agentId === config.AGENT_ID) continue;
        if (!configuredIds.has(agentId)) agentRegistry.delete(agentId);
      }
    }

    if (!agentRegistry.has(config.AGENT_ID)) {
      const defaultEntry = configAgents.find((entry) => entry.id === config.AGENT_ID);
      agentRegistry.set(config.AGENT_ID, normalizeAgentRecord(defaultEntry || {}, createDefaultAgent()));
    }
  }

  function mapToJsonObject(map) {
    const result = {};
    for (const [key, value] of map.entries()) {
      result[key] = cloneJson(value);
    }
    return result;
  }

  function hydratePlainObjectMap(map, raw, normalizer) {
    map.clear();
    if (!isPlainObject(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      const normalized = normalizer(value, key);
      if (normalized !== undefined) map.set(key, normalized);
    }
  }

  function computeConfigHash(sourceConfig = adapterConfig) {
    return crypto.createHash("sha256").update(stableStringify(sourceConfig)).digest("hex");
  }

  function computeExecApprovalsHash(sourceFile = execApprovalsFile) {
    return crypto.createHash("sha256").update(stableStringify(sourceFile)).digest("hex");
  }

  function normalizeExecApprovalsFile(rawFile) {
    const raw = isPlainObject(rawFile) ? rawFile : {};
    const defaults = isPlainObject(raw.defaults)
      ? cloneJson(raw.defaults)
      : createDefaultExecApprovalsFile().defaults;
    const agents = isPlainObject(raw.agents) ? cloneJson(raw.agents) : {};
    const next = {
      version: 1,
      defaults,
      agents,
    };
    if (isPlainObject(raw.socket)) next.socket = cloneJson(raw.socket);
    return next;
  }

  function parseConfigRaw(raw) {
    if (typeof raw !== "string") throw new Error("raw config JSON is required.");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error("raw config JSON must be an object.");
    return parsed;
  }

  function deepMergePlainObjects(base, patch) {
    const next = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch || {})) {
      const current = next[key];
      if (isPlainObject(current) && isPlainObject(value)) {
        next[key] = deepMergePlainObjects(current, value);
      } else {
        next[key] = cloneJson(value);
      }
    }
    return next;
  }

  class HermesAdapterStore {
    constructor(filePath) {
      this.filePath = filePath;
    }

    load() {
      if (!fs.existsSync(this.filePath)) return null;
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        return JSON.parse(raw);
      } catch (err) {
        console.warn("[hermes-adapter] Could not load adapter state:", sanitizeErrorMessage(err));
        return null;
      }
    }

    save(state) {
      const dir = path.dirname(this.filePath);
      const tempFile = path.join(dir, `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tempFile, this.filePath);
    }
  }

  const adapterStore = new HermesAdapterStore(config.ADAPTER_STATE_FILE);

  function buildAdapterStateSnapshot() {
    return {
      version: config.ADAPTER_STATE_SCHEMA_VERSION,
      agents: [...agentRegistry.values()].map((agent) => cloneJson(agent)),
      sessionSettings: mapToJsonObject(sessionSettings),
      config: cloneJson(adapterConfig),
      execApprovalsFile: cloneJson(execApprovalsFile),
      skillEnabledByKey: mapToJsonObject(skillEnabledByKey),
      cronJobs: mapToJsonObject(cronJobs),
      tasks: mapToJsonObject(tasksById),
      heartbeatStateByAgentId: mapToJsonObject(heartbeatStateByAgentId),
    };
  }

  function persistAdapterState() {
    try {
      adapterStore.save(buildAdapterStateSnapshot());
    } catch (err) {
      console.warn("[hermes-adapter] Could not save adapter state:", sanitizeErrorMessage(err));
    }
  }

  function loadAdapterStateFromDisk() {
    const state = adapterStore.load();
    if (!state) return;
    if (state.version !== config.ADAPTER_STATE_SCHEMA_VERSION) {
      console.warn(`[hermes-adapter] Ignoring unsupported adapter state version: ${state.version}`);
      return;
    }

    agentRegistry.clear();
    if (Array.isArray(state.agents)) {
      for (const rawAgent of state.agents) {
        const agent = normalizeAgentRecord(rawAgent, undefined);
        agentRegistry.set(agent.id, agent);
      }
    }
    if (!agentRegistry.has(config.AGENT_ID)) {
      agentRegistry.set(config.AGENT_ID, createDefaultAgent());
    }

    adapterConfig = isPlainObject(state.config) ? cloneJson(state.config) : createDefaultConfig();
    execApprovalsFile = normalizeExecApprovalsFile(state.execApprovalsFile);
    reconcileAgentRegistryFromConfig({ pruneNonDefault: Array.isArray(adapterConfig.agents?.list) });

    hydratePlainObjectMap(sessionSettings, state.sessionSettings, (value) =>
      isPlainObject(value) ? cloneJson(value) : undefined
    );
    hydratePlainObjectMap(skillEnabledByKey, state.skillEnabledByKey, (value) =>
      typeof value === "boolean" ? value : undefined
    );
    hydratePlainObjectMap(cronJobs, state.cronJobs, (value, key) => {
      if (!isPlainObject(value)) return undefined;
      return { ...cloneJson(value), id: typeof value.id === "string" ? value.id : key };
    });
    hydratePlainObjectMap(tasksById, state.tasks, (value, key) => {
      if (!isPlainObject(value)) return undefined;
      return { ...cloneJson(value), id: typeof value.id === "string" ? value.id : key };
    });
    hydratePlainObjectMap(heartbeatStateByAgentId, state.heartbeatStateByAgentId, (value) =>
      isPlainObject(value) ? cloneJson(value) : undefined
    );
  }

  function loadHistoryFromDisk() {
    if (historyLoadedFromDisk) return;
    historyLoadedFromDisk = true;
    try {
      if (fs.existsSync(config.HISTORY_FILE)) {
        const raw = fs.readFileSync(config.HISTORY_FILE, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [key, messages] of Object.entries(data)) {
            if (Array.isArray(messages)) conversationHistory.set(key, messages);
          }
          console.log(`[hermes-adapter] Loaded history for ${Object.keys(data).length} session(s).`);
        }
      }
    } catch (err) {
      console.warn("[hermes-adapter] Could not load history:", sanitizeErrorMessage(err));
    }
  }

  function saveHistoryToDisk() {
    if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
    persistDebounceTimer = setTimeout(() => {
      try {
        const data = {};
        for (const [key, messages] of conversationHistory.entries()) {
          if (messages.length > 0) data[key] = messages;
        }
        fs.mkdirSync(path.dirname(config.HISTORY_FILE), { recursive: true });
        fs.writeFileSync(config.HISTORY_FILE, JSON.stringify(data, null, 2), "utf8");
      } catch (err) {
        console.warn("[hermes-adapter] Could not save history:", sanitizeErrorMessage(err));
      }
    }, 500);
  }

  function getHistory(sessionKey) {
    if (!conversationHistory.has(sessionKey)) conversationHistory.set(sessionKey, []);
    return conversationHistory.get(sessionKey);
  }

  function clearHistory(sessionKey) {
    conversationHistory.delete(sessionKey);
    saveHistoryToDisk();
  }

  function getAdapterConfig() {
    return adapterConfig;
  }

  function replaceAdapterConfig(nextConfig) {
    adapterConfig = cloneJson(nextConfig);
  }

  function patchAdapterConfig(patch) {
    adapterConfig = deepMergePlainObjects(adapterConfig, patch);
  }

  function getExecApprovalsFile() {
    return execApprovalsFile;
  }

  function replaceExecApprovalsFile(nextFile) {
    execApprovalsFile = normalizeExecApprovalsFile(nextFile);
  }

  loadAdapterStateFromDisk();

  return {
    conversationHistory,
    sessionSettings,
    skillEnabledByKey,
    activeRuns,
    cronJobs,
    tasksById,
    heartbeatStateByAgentId,
    agentRegistry,
    createDefaultAgent,
    normalizeAgentRecord,
    agentToConfigEntry,
    createDefaultConfig,
    getConfigAgentList,
    upsertConfigAgent,
    removeConfigAgent,
    reconcileAgentRegistryFromConfig,
    computeConfigHash,
    computeExecApprovalsHash,
    parseConfigRaw,
    deepMergePlainObjects,
    getAdapterConfig,
    replaceAdapterConfig,
    patchAdapterConfig,
    getExecApprovalsFile,
    replaceExecApprovalsFile,
    persistAdapterState,
    loadHistoryFromDisk,
    saveHistoryToDisk,
    getHistory,
    clearHistory,
  };
}

module.exports = { createState };
