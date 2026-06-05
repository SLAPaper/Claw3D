"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");

function createEvents() {
  const activeSendEventFns = new Set();

  function broadcastEvent(frame) {
    for (const fn of activeSendEventFns) {
      try {
        fn(frame);
      } catch {
        // Ignore dead client callbacks.
      }
    }
  }

  return { activeSendEventFns, broadcastEvent };
}

function createStartAdapter(ctx, handleMethod) {
  const { config, events, utils, state, scheduler } = ctx;
  const { randomId, sanitizeErrorMessage, resErr } = utils;

  return function startAdapter() {
    let schedulerHandle = null;
    const httpServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Hermes Gateway Adapter – OK\n");
    });

    const wss = new WebSocketServer({ server: httpServer });
    wss.on("error", (err) => {
      if (err.code !== "EADDRINUSE") console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
    });

    wss.on("connection", (ws) => {
      let connected = false;
      let globalSeq = 0;

      const send = (frame) => {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(frame));
          } catch (err) {
            console.error("[hermes-adapter] send error:", sanitizeErrorMessage(err));
          }
        }
      };

      const sendEventFn = (frame) => {
        if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
        send(frame);
      };
      events.activeSendEventFns.add(sendEventFn);

      send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

      ws.on("message", async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (!frame || typeof frame !== "object" || frame.type !== "req") return;
        const { id, method, params } = frame;
        if (typeof id !== "string" || typeof method !== "string") return;

        if (method === "connect") {
          connected = true;
          const allAgents = [...state.agentRegistry.values()].map((agent) => ({
            agentId: agent.id,
            name: agent.name,
            isDefault: agent.id === config.AGENT_ID,
          }));
          send({
            type: "res",
            id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              adapterType: "hermes",
              features: {
                methods: [
                  "agents.list","agents.create","agents.delete","agents.update",
                  "sessions.list","sessions.preview","sessions.patch","sessions.reset","sessions.usage",
                  "chat.send","chat.abort","chat.history","agent.wait",
                  "status","config.get","config.set","config.patch",
                  "agents.files.get","agents.files.list","agents.files.set",
                  "exec.approvals.get","exec.approvals.set","exec.approval.resolve",
                  "wake","skills.status","skills.install","skills.update","models.list",
                  "tasks.list","tasks.create","tasks.update","tasks.delete",
                  "cron.list","cron.add","cron.remove","cron.patch","cron.run","usage.cost",
                ],
                events: ["chat","presence","heartbeat","cron","playbook_triggered","task_status_changed"],
              },
              snapshot: {
                health: { agents: allAgents, defaultAgentId: config.AGENT_ID },
                sessionDefaults: { mainKey: config.MAIN_KEY },
              },
              auth: { role: "operator", scopes: ["operator.admin","operator.approvals"] },
              policy: { tickIntervalMs: 30000 },
            },
          });
          return;
        }

        if (!connected) {
          send(resErr(id, "not_connected", "Send connect first."));
          return;
        }

        try {
          const response = await handleMethod(method, params, id, sendEventFn);
          send(response);
        } catch (err) {
          const message = sanitizeErrorMessage(err);
          console.error(`[hermes-adapter] Error handling ${method}:`, message);
          send(resErr(id, "internal_error", message || "Internal error"));
        }
      });

      ws.on("close", () => events.activeSendEventFns.delete(sendEventFn));
      ws.on("error", (err) => {
        console.error("[hermes-adapter] WebSocket error:", sanitizeErrorMessage(err));
        events.activeSendEventFns.delete(sendEventFn);
      });
    });

    httpServer.listen(config.ADAPTER_PORT, "127.0.0.1", () => {
      schedulerHandle = scheduler ? scheduler.start(handleMethod) : null;
      console.log(`\n[hermes-adapter] ✓ Listening on ws://localhost:${config.ADAPTER_PORT}`);
      console.log(`[hermes-adapter] ✓ Forwarding to Hermes API at ${config.HERMES_API_URL}`);
      console.log(`[hermes-adapter] ✓ Model: ${config.HERMES_MODEL}`);
      console.log("[hermes-adapter] ✓ Multi-agent orchestration: ENABLED");
      console.log(`\nOpen Claw3D → ws://localhost:${config.ADAPTER_PORT}\n`);
    });

    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[hermes-adapter] Port ${config.ADAPTER_PORT} in use. Set HERMES_ADAPTER_PORT to change it.`);
      } else {
        console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
      }
      process.exit(1);
    });

    httpServer.on("close", () => {
      schedulerHandle?.stop?.();
    });

    return {
      httpServer,
      wss,
      stop() {
        schedulerHandle?.stop?.();
        try {
          wss.close();
        } catch {
          // Best-effort shutdown.
        }
        try {
          httpServer.close();
        } catch {
          // Best-effort shutdown.
        }
      },
    };
  };
}

module.exports = { createEvents, createStartAdapter };
