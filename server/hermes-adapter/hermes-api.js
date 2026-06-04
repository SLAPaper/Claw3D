"use strict";

const http = require("http");
const https = require("https");

function createHermesApi(config, utils) {
  const { randomId } = utils;
  let cachedHermesModels = null;
  let cachedHermesModelsAt = 0;

  function hermesPost(apiPath, body) {
    return new Promise((resolve, reject) => {
      const urlStr = config.HERMES_API_URL + apiPath;
      let url;
      try {
        url = new URL(urlStr);
      } catch {
        reject(new Error(`Invalid URL: ${urlStr}`));
        return;
      }
      const transport = url.protocol === "https:" ? https : http;
      const bodyStr = JSON.stringify(body);
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      };
      if (config.HERMES_API_KEY) headers.Authorization = `Bearer ${config.HERMES_API_KEY}`;
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + (url.search || ""),
          method: "POST",
          headers,
        },
        resolve
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  function hermesGet(apiPath) {
    return new Promise((resolve, reject) => {
      const urlStr = config.HERMES_API_URL + apiPath;
      let url;
      try {
        url = new URL(urlStr);
      } catch {
        reject(new Error(`Invalid URL: ${urlStr}`));
        return;
      }
      const transport = url.protocol === "https:" ? https : http;
      const headers = {};
      if (config.HERMES_API_KEY) headers.Authorization = `Bearer ${config.HERMES_API_KEY}`;
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + (url.search || ""),
          method: "GET",
          headers,
        },
        resolve
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function readJsonBody(res) {
    const chunks = [];
    for await (const chunk of res) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }

  function extractOpenAiStyleError(payload, fallbackMessage) {
    if (payload && typeof payload === "object") {
      const message =
        typeof payload?.error?.message === "string"
          ? payload.error.message.trim()
          : "";
      if (message) return message;
    }
    return fallbackMessage;
  }

  async function fetchHermesModels() {
    const now = Date.now();
    if (cachedHermesModels && now - cachedHermesModelsAt < 30_000) {
      return cachedHermesModels;
    }
    const res = await hermesGet("/v1/models");
    if (res.statusCode >= 400) {
      res.resume();
      throw new Error(`Hermes models API HTTP ${res.statusCode}`);
    }
    const payload = await readJsonBody(res);
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
          .filter(Boolean)
      : [];
    cachedHermesModels = models;
    cachedHermesModelsAt = now;
    return models;
  }

  async function resolveHermesModel(requestedModel) {
    const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
    const normalized = trimmed.includes("/") ? trimmed.split("/").pop().trim() : trimmed;
    try {
      const models = await fetchHermesModels();
      if (models.length === 0) {
        return normalized || trimmed || config.HERMES_MODEL;
      }
      const candidates = [trimmed, normalized, config.HERMES_MODEL]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);
      for (const candidate of candidates) {
        const exact = models.find((modelId) => modelId === candidate);
        if (exact) return exact;
      }
      for (const candidate of candidates) {
        const suffix = models.find((modelId) => modelId.endsWith(`/${candidate}`));
        if (suffix) return suffix;
      }
      return models[0];
    } catch {
      return normalized || trimmed || config.HERMES_MODEL;
    }
  }

  async function completeOneTurn(messages, model, tools) {
    const resolvedModel = await resolveHermesModel(model);
    const body = { model: resolvedModel, messages, stream: false };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const res = await hermesPost("/v1/chat/completions", body);
    const payload = await readJsonBody(res);
    if (res.statusCode >= 400) {
      throw new Error(
        extractOpenAiStyleError(payload, `Hermes API HTTP ${res.statusCode}`)
      );
    }
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const message = choice?.message || {};
    const textContent =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .join("")
          : "";
    const finishReason =
      typeof choice?.finish_reason === "string" && choice.finish_reason
        ? choice.finish_reason
        : "stop";
    const toolCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((tc) => {
          let args = {};
          const rawArgs = tc?.function?.arguments;
          if (typeof rawArgs === "string" && rawArgs.trim()) {
            try {
              args = JSON.parse(rawArgs);
            } catch {
              args = { _raw: rawArgs };
            }
          }
          return {
            id: typeof tc?.id === "string" ? tc.id : randomId(),
            name: typeof tc?.function?.name === "string" ? tc.function.name : "",
            args,
          };
        })
      : [];
    return { textContent, toolCalls, finishReason, resolvedModel };
  }

  async function streamOneTurn(messages, model, tools, onTextDelta, abortCheck) {
    const body = { model, messages, stream: true };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const resolvedModel = await resolveHermesModel(model);
    body.model = resolvedModel;
    const res = await hermesPost("/v1/chat/completions", body);
    if (res.statusCode >= 400) {
      res.resume();
      throw new Error(`Hermes API HTTP ${res.statusCode}`);
    }

    let textContent = "";
    let finishReason = "stop";
    const toolCallAccum = {};
    let buffer = "";

    await new Promise((resolve, reject) => {
      res.on("data", (chunk) => {
        if (abortCheck && abortCheck()) {
          res.destroy();
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(trimmed.slice(6));
            const choice = data?.choices?.[0];
            if (!choice) continue;
            if (typeof choice.finish_reason === "string" && choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const delta = choice.delta || {};
            if (typeof delta.content === "string" && delta.content) {
              textContent += delta.content;
              if (onTextDelta) onTextDelta(textContent);
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: "", name: "", argsStr: "" };
                if (tc.id) toolCallAccum[idx].id = tc.id;
                if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallAccum[idx].argsStr += tc.function.arguments;
              }
            }
          } catch {
            // Ignore malformed SSE chunks.
          }
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });

    const toolCalls = Object.values(toolCallAccum).map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.argsStr);
      } catch {
        args = { _raw: tc.argsStr };
      }
      return { id: tc.id, name: tc.name, args };
    });

    if (!textContent.trim() && toolCalls.length === 0 && finishReason === "stop") {
      const fallback = await completeOneTurn(messages, resolvedModel, tools);
      return {
        textContent: fallback.textContent,
        toolCalls: fallback.toolCalls,
        finishReason: fallback.finishReason,
      };
    }

    return { textContent, toolCalls, finishReason };
  }

  return {
    fetchHermesModels,
    resolveHermesModel,
    completeOneTurn,
    streamOneTurn,
  };
}

module.exports = { createHermesApi };
