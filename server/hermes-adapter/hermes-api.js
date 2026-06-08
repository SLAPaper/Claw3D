"use strict";

const http = require("http");
const https = require("https");

function createHermesApi(config, utils) {
  const { randomId } = utils;
  let cachedHermesModels = null;
  let cachedHermesModelsAt = 0;

  function createHttpError(message, statusCode, payload) {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.payload = payload;
    return err;
  }

  function buildHeaders(bodyStr, extraHeaders = {}) {
    const headers = {
      ...extraHeaders,
    };
    if (bodyStr !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    if (config.HERMES_API_KEY) headers.Authorization = `Bearer ${config.HERMES_API_KEY}`;
    return headers;
  }

  function hermesRequest(method, apiPath, body, extraHeaders) {
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
      const bodyStr = body === undefined ? null : JSON.stringify(body);
      const headers = buildHeaders(bodyStr, extraHeaders);
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + (url.search || ""),
          method,
          headers,
        },
        resolve
      );
      req.on("error", reject);
      if (bodyStr !== null) req.write(bodyStr);
      req.end();
    });
  }

  function hermesPost(apiPath, body, extraHeaders) {
    return hermesRequest("POST", apiPath, body, extraHeaders);
  }

  function hermesGet(apiPath, extraHeaders) {
    return hermesRequest("GET", apiPath, undefined, extraHeaders);
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

  async function requestJson(method, apiPath, body, extraHeaders) {
    const res = await hermesRequest(method, apiPath, body, extraHeaders);
    const payload = await readJsonBody(res);
    if (res.statusCode >= 400) {
      throw createHttpError(
        `Hermes API ${method} ${apiPath} HTTP ${res.statusCode}`,
        res.statusCode,
        payload
      );
    }
    return payload;
  }

  function extractSession(payload) {
    if (payload && typeof payload === "object" && payload.session && typeof payload.session === "object") {
      return payload.session;
    }
    return payload;
  }

  async function listNativeSessions(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 500)) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
    const payload = await requestJson("GET", `/api/sessions?limit=${limit}&offset=${offset}`);
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.sessions)) return payload.sessions;
    return [];
  }

  async function getNativeSession(sessionId) {
    const encoded = encodeURIComponent(sessionId);
    return extractSession(await requestJson("GET", `/api/sessions/${encoded}`));
  }

  async function createNativeSession(input) {
    const body = {
      id: input.sessionId,
      session_id: input.sessionId,
      title: input.title || "Main",
    };
    if (input.model) body.model = input.model;
    if (input.systemPrompt) body.system_prompt = input.systemPrompt;
    return extractSession(await requestJson("POST", "/api/sessions", body));
  }

  async function patchNativeSession(sessionId, patch) {
    const body = {};
    if (typeof patch?.title === "string") body.title = patch.title;
    if (typeof patch?.endReason === "string") body.end_reason = patch.endReason;
    if (Object.keys(body).length === 0) return null;
    return extractSession(await requestJson("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, body));
  }

  async function deleteNativeSession(sessionId) {
    return requestJson("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async function listNativeSessionMessages(sessionId) {
    const payload = await requestJson("GET", `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.messages)) return payload.messages;
    return [];
  }

  function normalizeSseData(rawData) {
    if (typeof rawData !== "string" || !rawData.trim()) return {};
    try {
      return JSON.parse(rawData);
    } catch {
      return { text: rawData };
    }
  }

  function extractAssistantDelta(eventName, payload) {
    if (!payload || typeof payload !== "object") return "";
    if (typeof payload.delta === "string") return payload.delta;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.content === "string") return payload.content;
    if (typeof payload.message?.content === "string") return payload.message.content;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (typeof choice?.delta?.content === "string") return choice.delta.content;
    if (eventName === "assistant.delta" && typeof payload.message === "string") return payload.message;
    return "";
  }

  async function streamNativeSessionChat(input) {
    const body = {
      message: input.message,
    };
    if (input.model) body.model = input.model;
    if (input.profileName && input.profileName !== "default") body.profile = input.profileName;
    const headers = {};
    if (input.sessionKey) headers["X-Hermes-Session-Key"] = input.sessionKey;
    const res = await hermesPost(
      `/api/sessions/${encodeURIComponent(input.sessionId)}/chat/stream`,
      body,
      headers
    );
    if (res.statusCode >= 400) {
      const payload = await readJsonBody(res);
      throw createHttpError(
        `Hermes API POST /api/sessions/${input.sessionId}/chat/stream HTTP ${res.statusCode}`,
        res.statusCode,
        payload
      );
    }

    let buffer = "";
    let currentEvent = "message";
    let currentData = [];
    let textContent = "";
    let completedMessages = null;
    let usage = null;
    let finishReason = "end_turn";
    let streamError = null;

    const flushEvent = () => {
      if (currentData.length === 0) {
        currentEvent = "message";
        return;
      }
      const payload = normalizeSseData(currentData.join("\n"));
      if (input.onEvent) input.onEvent(currentEvent, payload);
      const delta = extractAssistantDelta(currentEvent, payload);
      if (delta) {
        textContent += delta;
        if (input.onTextDelta) input.onTextDelta(textContent, delta, payload);
      }
      if (currentEvent === "run.completed") {
        if (Array.isArray(payload?.messages)) completedMessages = payload.messages;
        if (payload?.usage && typeof payload.usage === "object") usage = payload.usage;
        if (typeof payload?.finish_reason === "string") finishReason = payload.finish_reason;
        if (typeof payload?.finishReason === "string") finishReason = payload.finishReason;
      }
      if (currentEvent === "error") {
        streamError = payload?.error || payload?.message || "Hermes native session stream error";
      }
      currentEvent = "message";
      currentData = [];
    };

    await new Promise((resolve, reject) => {
      res.on("data", (chunk) => {
        if (input.abortCheck && input.abortCheck()) {
          res.destroy();
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            flushEvent();
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim() || "message";
            continue;
          }
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            currentData.push(data);
          }
        }
      });
      res.on("end", () => {
        flushEvent();
        resolve();
      });
      res.on("error", reject);
    });

    if (streamError) {
      throw new Error(typeof streamError === "string" ? streamError : JSON.stringify(streamError));
    }

    return {
      textContent,
      messages: completedMessages,
      usage,
      finishReason,
    };
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
    return { textContent, toolCalls, finishReason, resolvedModel, usage: payload?.usage };
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
    let usage = null;
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
            if (data && typeof data.usage === "object" && data.usage) {
              usage = data.usage;
            }
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
        resolvedModel: fallback.resolvedModel || resolvedModel,
        usage: fallback.usage,
      };
    }

    return { textContent, toolCalls, finishReason, resolvedModel, usage };
  }

  return {
    fetchHermesModels,
    resolveHermesModel,
    completeOneTurn,
    streamOneTurn,
    listNativeSessions,
    getNativeSession,
    createNativeSession,
    patchNativeSession,
    deleteNativeSession,
    listNativeSessionMessages,
    streamNativeSessionChat,
  };
}

module.exports = { createHermesApi };
