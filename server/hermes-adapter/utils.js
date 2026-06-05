"use strict";

const crypto = require("crypto");
const path = require("path");

function createUtils(config) {
  function randomId() {
    return crypto.randomBytes(8).toString("hex");
  }

  function redactSecrets(value) {
    if (typeof value !== "string" || !value) return value;
    let redacted = value;
    if (config.HERMES_API_KEY) {
      redacted = redacted.split(config.HERMES_API_KEY).join("[REDACTED]");
    }
    if (config.HERMES_PROFILE_API_TOKEN) {
      redacted = redacted.split(config.HERMES_PROFILE_API_TOKEN).join("[REDACTED]");
    }
    if (config.HERMES_DASHBOARD_SESSION_TOKEN) {
      redacted = redacted.split(config.HERMES_DASHBOARD_SESSION_TOKEN).join("[REDACTED]");
    }
    redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
    redacted = redacted.replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
    return redacted;
  }

  function sanitizeErrorMessage(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return redactSecrets(error);
    return redactSecrets(error.message || String(error));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function stableJsonValue(value) {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (!isPlainObject(value)) return value;
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableJsonValue(value[key]);
    }
    return sorted;
  }

  function stableStringify(value) {
    return JSON.stringify(stableJsonValue(value));
  }

  function slugifyName(value) {
    const slug = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || "agent";
  }

  function normalizePathForValidation(value) {
    return value.replace(/\\/g, "/");
  }

  function isPathInside(parentPath, childPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function resolveAgentIdFromSessionKey(sessionKey) {
    return sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : config.AGENT_ID;
  }

  function resOk(id, payload) {
    return { type: "res", id, ok: true, payload: payload ?? {} };
  }

  function resErr(id, code, message) {
    return { type: "res", id, ok: false, error: { code, message } };
  }

  return {
    randomId,
    redactSecrets,
    sanitizeErrorMessage,
    isPlainObject,
    cloneJson,
    stableStringify,
    slugifyName,
    normalizePathForValidation,
    isPathInside,
    resolveAgentIdFromSessionKey,
    resOk,
    resErr,
  };
}

module.exports = { createUtils };
