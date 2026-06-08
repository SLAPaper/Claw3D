"use strict";

const http = require("http");
const https = require("https");
const path = require("path");

function createProfiles(config, utils) {
  const {
    cloneJson,
    isPlainObject,
    sanitizeErrorMessage,
    slugifyName,
  } = utils;

  function getBaseUrl() {
    return config.HERMES_PROFILE_API_URL || "";
  }

  function getToken() {
    return config.HERMES_PROFILE_API_TOKEN || config.HERMES_DASHBOARD_SESSION_TOKEN || "";
  }

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function isConfigured() {
    return Boolean(getBaseUrl());
  }

  function slugifyProfileName(value) {
    return slugifyName(value);
  }

  function agentIdForProfileName(profileName, isDefault = false) {
    const name = trimString(profileName);
    if (isDefault || name === "default") return config.AGENT_ID;
    return name;
  }

  function profileNameForAgentId(agentId) {
    return agentId === config.AGENT_ID ? "default" : agentId;
  }

  function normalizeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function normalizeProfile(rawProfile) {
    const raw = isPlainObject(rawProfile) ? rawProfile : {};
    const rawName = trimString(raw.name);
    const isDefault = raw.is_default === true || rawName === "default";
    const name = isDefault ? "default" : rawName;
    if (!name) return null;
    return {
      name,
      path: trimString(raw.path),
      isDefault,
      description: trimString(raw.description),
      descriptionAuto: raw.description_auto === true,
      model: trimString(raw.model) || null,
      provider: trimString(raw.provider) || null,
      hasEnv: raw.has_env === true,
      skillCount: normalizeNumber(raw.skill_count),
      gatewayRunning:
        raw.gateway_running === undefined || raw.gateway_running === null
          ? null
          : Boolean(raw.gateway_running),
    };
  }

  function extractProfiles(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.profiles)) {
      throw new Error("Hermes profile API returned an invalid profiles payload.");
    }
    return payload.profiles
      .map((profile) => normalizeProfile(profile))
      .filter((profile) => profile !== null);
  }

  function profileToAgent(rawProfile, fallbackAgent = {}) {
    const profile = normalizeProfile(rawProfile);
    if (!profile) {
      throw new Error("Hermes profile record is missing a profile name.");
    }
    const agentId = agentIdForProfileName(profile.name, profile.isDefault);
    const fallback = isPlainObject(fallbackAgent) ? fallbackAgent : {};
    const name = profile.isDefault ? config.HERMES_AGENT_NAME : profile.name;
    const fallbackWorkspace = trimString(fallback.workspace);
    const workspace = profile.path || fallbackWorkspace || path.join(
      config.HOME,
      ".hermes",
      profile.isDefault ? "workspace-hermes" : "profiles",
      profile.isDefault ? "" : profile.name
    ).replace(/[\\/]$/, "");
    const role = profile.description || trimString(fallback.role) || (profile.isDefault ? "Orchestrator" : "");
    const fallbackSettings = isPlainObject(fallback.settings) ? fallback.settings : {};
    const settings = {
      ...cloneJson(fallbackSettings),
      wipe: Boolean(fallbackSettings.wipe),
      continuity: fallbackSettings.continuity !== false,
      model: profile.model || trimString(fallbackSettings.model) || config.HERMES_MODEL,
    };
    return {
      id: agentId,
      name,
      workspace,
      role,
      systemPrompt: trimString(fallback.systemPrompt)
        || (profile.isDefault ? config.ORCHESTRATOR_SYSTEM_PROMPT : `You are the Hermes profile ${profile.name}.`),
      settings,
      metadata: {
        hermesProfileName: profile.name,
        hermesProfilePath: profile.path || null,
        hermesProfileSource: "dashboard",
        hermesProfileIsDefault: profile.isDefault,
        hermesProfileProvider: profile.provider,
        hermesProfileModel: profile.model,
        hermesProfileHasEnv: profile.hasEnv,
        hermesProfileSkillCount: profile.skillCount,
        hermesProfileGatewayRunning: profile.gatewayRunning,
        hermesProfileDescriptionAuto: profile.descriptionAuto,
      },
    };
  }

  function extractErrorDetail(parsed, rawText) {
    if (isPlainObject(parsed)) {
      if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
      if (isPlainObject(parsed.detail)) return JSON.stringify(parsed.detail);
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (isPlainObject(parsed.error) && typeof parsed.error.message === "string") {
        return parsed.error.message.trim();
      }
    }
    return rawText.trim() || "unknown error";
  }

  function requestJson(method, apiPath, body) {
    if (!isConfigured()) {
      return Promise.reject(new Error("Hermes profile API URL is not configured."));
    }
    const baseUrl = getBaseUrl();
    const token = getToken();
    const url = new URL(apiPath, `${baseUrl}/`);
    const bodyText = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Accept: "application/json",
    };
    if (token) headers["X-Hermes-Session-Token"] = token;
    if (bodyText !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyText);
    }
    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (rawText.trim()) {
            try {
              parsed = JSON.parse(rawText);
            } catch {
              parsed = {};
            }
          }
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            const detail = extractErrorDetail(parsed, rawText);
            reject(new Error(`Hermes profile API ${method} ${apiPath} failed with ${status}: ${detail}`));
            return;
          }
          resolve(parsed);
        });
      });
      req.setTimeout(10000, () => {
        req.destroy(new Error(`Hermes profile API ${method} ${apiPath} timed out.`));
      });
      req.on("error", (err) => {
        reject(new Error(`Hermes profile API ${method} ${apiPath} failed: ${sanitizeErrorMessage(err)}`));
      });
      if (bodyText !== null) req.write(bodyText);
      req.end();
    });
  }

  async function listProfiles() {
    return extractProfiles(await requestJson("GET", "/api/profiles"));
  }

  async function createProfile(input) {
    const profileName = slugifyProfileName(input?.name);
    const body = {
      name: profileName,
      clone_from_default: input?.cloneFromDefault !== false,
    };
    const description = trimString(input?.description);
    const provider = trimString(input?.provider);
    const model = trimString(input?.model);
    if (description) body.description = description;
    if (provider) body.provider = provider;
    if (model) body.model = model;
    const response = await requestJson("POST", "/api/profiles", body);
    return normalizeProfile({
      ...response,
      name: trimString(response?.name) || profileName,
      path: trimString(response?.path),
      is_default: false,
      description,
      provider,
      model,
    });
  }

  async function renameProfile(profileName, newProfileName) {
    const from = trimString(profileName);
    const to = slugifyProfileName(newProfileName);
    return requestJson("PATCH", `/api/profiles/${encodeURIComponent(from)}`, { new_name: to });
  }

  async function deleteProfile(profileName) {
    const name = trimString(profileName);
    return requestJson("DELETE", `/api/profiles/${encodeURIComponent(name)}`);
  }

  async function updateProfileDescription(profileName, description) {
    const name = trimString(profileName);
    return requestJson("PUT", `/api/profiles/${encodeURIComponent(name)}/description`, {
      description: trimString(description),
    });
  }

  return {
    isConfigured,
    slugifyProfileName,
    agentIdForProfileName,
    profileNameForAgentId,
    normalizeProfile,
    profileToAgent,
    listProfiles,
    createProfile,
    renameProfile,
    deleteProfile,
    updateProfileDescription,
  };
}

module.exports = { createProfiles };
