"use strict";

const fs = require("fs");
const path = require("path");

function createSkills(config, state, utils) {
  const {
    isPathInside,
    normalizePathForValidation,
    sanitizeErrorMessage,
  } = utils;

  function parseJsonStringLiteral(value, label) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") {
        throw new Error(`${label} must be a JSON string.`);
      }
      return parsed;
    } catch (err) {
      if (err && typeof err.message === "string" && err.message.includes("must be")) {
        throw err;
      }
      throw new Error(`Invalid installer ${label}.`);
    }
  }

  function parseInstallerFiles(message) {
    const filesMarker = "\nFiles:";
    const markerIndex = message.indexOf(filesMarker);
    if (markerIndex < 0) {
      throw new Error("Invalid skill installer request: missing Files block.");
    }

    const lines = message.slice(markerIndex + filesMarker.length).split(/\r?\n/);
    const files = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      const pathMatch = line.match(/^\s*-\s*path:\s*(.+)\s*$/);
      if (!pathMatch) {
        throw new Error("Invalid skill installer request: expected file path entry.");
      }
      const contentLine = lines[index + 1] ?? "";
      const contentMatch = contentLine.match(/^\s*content:\s*(.+)\s*$/);
      if (!contentMatch) {
        throw new Error("Invalid skill installer request: expected file content entry.");
      }
      index += 1;

      files.push({
        relativePath: parseJsonStringLiteral(pathMatch[1].trim(), "file path"),
        content: parseJsonStringLiteral(contentMatch[1].trim(), "file content"),
      });
    }

    if (files.length === 0) {
      throw new Error("Invalid skill installer request: no files provided.");
    }
    return files;
  }

  function resolveInstallerFilePath(workspaceDir, relativePath) {
    const normalized = normalizePathForValidation(relativePath.trim());
    const segments = normalized.split("/");
    const hasInvalidSegment = segments.some((segment) => !segment || segment === "." || segment === "..");
    const hasDrivePrefix = /^[A-Za-z]:/.test(normalized);
    if (
      !normalized.startsWith("skills/") ||
      hasInvalidSegment ||
      hasDrivePrefix ||
      path.isAbsolute(relativePath) ||
      path.isAbsolute(normalized)
    ) {
      throw new Error(`Invalid installer file path: ${relativePath}`);
    }

    const targetPath = path.resolve(workspaceDir, ...segments);
    if (!isPathInside(workspaceDir, targetPath)) {
      throw new Error(`Invalid installer file path outside workspace: ${relativePath}`);
    }
    return targetPath;
  }

  function writeSkillInstallerFiles(agent, message) {
    const workspaceDir = typeof agent?.workspace === "string" ? agent.workspace.trim() : "";
    if (!workspaceDir) {
      throw new Error("Cannot install skill files because the Hermes agent has no workspace.");
    }

    const files = parseInstallerFiles(message);
    for (const file of files) {
      const targetPath = resolveInstallerFilePath(workspaceDir, file.relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.content, "utf8");
    }
    return { workspaceDir, filesWritten: files.length };
  }

  function parseSkillFrontmatter(content) {
    const lines = content.split(/\r?\n/);
    if ((lines[0] || "").trim() !== "---") {
      return {};
    }
    const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (endIndex < 0) {
      return {};
    }

    const fields = {};
    for (const line of lines.slice(1, endIndex)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      fields[match[1]] = match[2].trim();
    }

    let metadata = null;
    if (typeof fields.metadata === "string" && fields.metadata) {
      try {
        metadata = JSON.parse(fields.metadata);
      } catch {
        metadata = null;
      }
    }
    return {
      name: typeof fields.name === "string" ? fields.name : "",
      description: typeof fields.description === "string" ? fields.description : "",
      skillKey: typeof metadata?.openclaw?.skillKey === "string" ? metadata.openclaw.skillKey : "",
    };
  }

  function emptySkillRequirementSet() {
    return { bins: [], anyBins: [], env: [], config: [], os: [] };
  }

  function buildSkillStatusEntry(params) {
    const content = fs.readFileSync(params.skillDocPath, "utf8");
    const frontmatter = parseSkillFrontmatter(content);
    const fallbackKey = path.basename(params.baseDir);
    const skillKey = (frontmatter.skillKey || fallbackKey).trim();
    const disabled = state.skillEnabledByKey.get(skillKey) === false;
    return {
      name: (frontmatter.name || fallbackKey).trim(),
      description: (frontmatter.description || "").trim(),
      source: params.source,
      bundled: false,
      filePath: params.skillDocPath,
      baseDir: params.baseDir,
      skillKey,
      always: false,
      disabled,
      blockedByAllowlist: false,
      eligible: !disabled,
      requirements: emptySkillRequirementSet(),
      missing: emptySkillRequirementSet(),
      configChecks: [],
      install: [],
    };
  }

  function scanSkillParentDir(parentDir, source) {
    if (!fs.existsSync(parentDir)) return [];
    let entries;
    try {
      entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const baseDir = path.join(parentDir, entry.name);
      const skillDocPath = path.join(baseDir, "SKILL.md");
      if (!fs.existsSync(skillDocPath)) continue;
      try {
        skills.push(buildSkillStatusEntry({ source, baseDir, skillDocPath }));
      } catch (err) {
        console.warn(`[hermes-adapter] Could not read skill ${skillDocPath}:`, sanitizeErrorMessage(err));
      }
    }
    return skills;
  }

  function buildSkillStatusReport(agent) {
    const workspaceDir = typeof agent?.workspace === "string" ? agent.workspace : "";
    const workspaceSkillsDir = workspaceDir ? path.join(workspaceDir, "skills") : "";
    const skills = [
      ...scanSkillParentDir(workspaceSkillsDir, "openclaw-workspace"),
      ...scanSkillParentDir(config.MANAGED_SKILLS_DIR, "openclaw-managed"),
    ].sort((a, b) => a.skillKey.localeCompare(b.skillKey) || a.source.localeCompare(b.source));
    return { workspaceDir, managedSkillsDir: config.MANAGED_SKILLS_DIR, skills };
  }

  return {
    writeSkillInstallerFiles,
    buildSkillStatusReport,
  };
}

module.exports = { createSkills };
