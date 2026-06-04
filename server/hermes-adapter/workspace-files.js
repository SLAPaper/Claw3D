"use strict";

const fs = require("fs");
const path = require("path");

const AGENT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];

function createWorkspaceFiles(config, utils) {
  const {
    isPathInside,
    normalizePathForValidation,
  } = utils;

  function getWorkspaceDir(agent) {
    const workspaceDir = typeof agent?.workspace === "string" ? agent.workspace.trim() : "";
    if (!workspaceDir) {
      throw new Error("Agent workspace is required.");
    }
    return workspaceDir;
  }

  function bootstrapContent(agent, name) {
    const agentName = typeof agent?.name === "string" && agent.name.trim() ? agent.name.trim() : "Agent";
    switch (name) {
      case "IDENTITY.md":
        return [
          "# IDENTITY.md - Who Am I?",
          "",
          `- Name: ${agentName}`,
          "- Creature:",
          "- Vibe:",
          "- Emoji:",
          "- Avatar:",
          "",
        ].join("\n");
      case "SOUL.md":
        return [
          "# SOUL.md - Who You Are",
          "",
          "## Core Truths",
          "",
          "## Boundaries",
          "",
          "## Vibe",
          "",
          "## Continuity",
          "",
        ].join("\n");
      case "AGENTS.md":
        return [
          "# AGENTS.md",
          "",
          `You are ${agentName}. Keep work clear, useful, and grounded in the current workspace.`,
          "",
        ].join("\n");
      case "USER.md":
        return [
          "# USER.md - About Your Human",
          "",
          "- Name:",
          "- What to call them:",
          "- Pronouns:",
          "- Timezone:",
          "- Notes:",
          "",
          "## Context",
          "",
        ].join("\n");
      case "TOOLS.md":
        return [
          "# TOOLS.md",
          "",
          "Record local tool notes, conventions, and shortcuts here.",
          "",
        ].join("\n");
      case "HEARTBEAT.md":
        return [
          "# HEARTBEAT.md",
          "",
          "Use this file for periodic checklists, reminders, and heartbeat notes.",
          "",
        ].join("\n");
      case "MEMORY.md":
        return [
          "# MEMORY.md",
          "",
          "Record durable facts, decisions, and preferences for this agent here.",
          "",
        ].join("\n");
      default:
        return "";
    }
  }

  function ensureAgentWorkspace(agent) {
    const workspaceDir = getWorkspaceDir(agent);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function ensureBootstrapFiles(agent) {
    const workspaceDir = ensureAgentWorkspace(agent);
    for (const name of AGENT_FILE_NAMES) {
      const targetPath = path.join(workspaceDir, name);
      if (fs.existsSync(targetPath)) continue;
      fs.writeFileSync(targetPath, bootstrapContent(agent, name), "utf8");
    }
    return { workspaceDir, files: AGENT_FILE_NAMES.slice() };
  }

  function resolveWorkspaceFilePath(agent, relativePath, options = {}) {
    const label = options.label || "agent file path";
    const rawPath = typeof relativePath === "string" ? relativePath.trim() : "";
    const normalized = normalizePathForValidation(rawPath);
    const segments = normalized.split("/");
    const requiredPrefix = typeof options.requiredPrefix === "string" ? options.requiredPrefix : "";
    const hasInvalidSegment = segments.some((segment) => !segment || segment === "." || segment === "..");
    const hasDrivePrefix = /^[A-Za-z]:/.test(normalized);
    const invalid =
      !normalized ||
      hasInvalidSegment ||
      hasDrivePrefix ||
      path.isAbsolute(rawPath) ||
      path.isAbsolute(normalized) ||
      (requiredPrefix && !normalized.startsWith(requiredPrefix));

    if (invalid) {
      throw new Error(`Invalid ${label}: ${rawPath || "(empty)"}`);
    }

    const workspaceDir = getWorkspaceDir(agent);
    const targetPath = path.resolve(workspaceDir, ...segments);
    if (!isPathInside(workspaceDir, targetPath)) {
      throw new Error(`Invalid ${label} outside workspace: ${rawPath}`);
    }
    return { workspaceDir, targetPath, name: normalized };
  }

  function readAgentFile(agent, relativePath) {
    ensureBootstrapFiles(agent);
    const { workspaceDir, targetPath } = resolveWorkspaceFilePath(agent, relativePath);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return {
        workspace: workspaceDir,
        file: { missing: true, path: targetPath },
      };
    }
    return {
      workspace: workspaceDir,
      file: { content: fs.readFileSync(targetPath, "utf8"), path: targetPath },
    };
  }

  function writeAgentFile(agent, relativePath, content, options = {}) {
    if (options.bootstrap !== false) ensureBootstrapFiles(agent);
    else ensureAgentWorkspace(agent);
    const { workspaceDir, targetPath, name } = resolveWorkspaceFilePath(agent, relativePath, options);
    const fileContent = typeof content === "string" ? content : "";
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, fileContent, "utf8");
    return {
      workspace: workspaceDir,
      file: {
        name,
        path: targetPath,
        missing: false,
        size: Buffer.byteLength(fileContent, "utf8"),
      },
    };
  }

  function listAgentFiles(agent) {
    const { workspaceDir } = ensureBootstrapFiles(agent);
    const files = [];

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativeName = normalizePathForValidation(path.relative(workspaceDir, absolutePath));
        files.push({
          name: relativeName,
          path: absolutePath,
          missing: false,
          size: fs.statSync(absolutePath).size,
        });
      }
    }

    walk(workspaceDir);
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { workspace: workspaceDir, files };
  }

  return {
    AGENT_FILE_NAMES,
    ensureAgentWorkspace,
    ensureBootstrapFiles,
    resolveWorkspaceFilePath,
    readAgentFile,
    writeAgentFile,
    listAgentFiles,
  };
}

module.exports = { createWorkspaceFiles };
