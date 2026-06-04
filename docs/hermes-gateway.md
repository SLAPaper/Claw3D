# Hermes Gateway Adapter

Claw3D can run against Hermes by using the bundled adapter in
[`server/hermes-gateway-adapter.js`](../server/hermes-gateway-adapter.js).
That file remains the public entrypoint; the implementation is split under
[`server/hermes-adapter/`](../server/hermes-adapter/) by runtime concern.

This is the current production-ready Hermes path in this repository.
It is not yet a fully native Studio-side Hermes provider. Instead, it
uses the runtime seam in Studio while Hermes is exposed through a
Claw3D-compatible WebSocket adapter.

## Architecture

```text
Browser UI <-> Studio runtime/client <-> Hermes gateway adapter <-> Hermes HTTP API
```

The frontend keeps using the Claw3D gateway protocol. The Hermes adapter
translates that protocol into Hermes HTTP calls and streams the results
back as gateway events.

## Quick start

### 1. Start Hermes

Start your Hermes API server. The default expected endpoint is:

```text
http://localhost:8642
```

### 2. Configure environment

Copy `.env.example` to `.env` and set the Hermes values:

```env
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:18789

HERMES_API_URL=http://localhost:8642
HERMES_API_KEY=
HERMES_ADAPTER_PORT=18789
HERMES_MODEL=hermes
HERMES_AGENT_NAME=Hermes
HERMES_ADAPTER_STATE_DIR=
```

### 3. Start Claw3D and the adapter

In separate terminals:

```bash
npm run hermes-adapter
npm run dev
```

Then open `http://localhost:3000` and connect to:

```text
ws://localhost:18789
```

In the connect screen, select `Hermes backend`. Claw3D will persist that
selection in Studio settings and show `Hermes` as the active backend once
the adapter hello response is received.

### 4. Optional all-in-one local startup

The repo also includes:

```bash
bash scripts/clawd3d-start.sh
```

That script now resolves the repo root dynamically from the script
location instead of assuming a machine-specific checkout path.

## What this adapter supports

The adapter currently supports the Claw3D surfaces needed for normal
office use:

- Agent listing, creation, update, and deletion
- Session listing, preview, patch, reset, and history lookup
- Chat send, targeted abort, and run wait
- Workspace-backed `agents.files.get/list/set` with bootstrap agent brain files
- Persisted config get/set/patch with hash protection for Studio writes
- Models and skills status
- Exec approvals surfaces used by the current UI
- Cron list/add/remove/patch/run
- Multi-agent orchestration tools on the Hermes side

## Hermes orchestration tools

The main Hermes agent acts as an orchestrator with these tools:

| Tool | Description |
|---|---|
| `spawn_agent` | Create a specialist sub-agent |
| `delegate_task` | Send work to a specific agent |
| `list_team` | List active agents, names, and roles |
| `configure_agent` | Update agent name, role, instructions, or settings |
| `dismiss_agent` | Remove an agent from the team |
| `read_agent_context` | Read another agent's recent conversation history for coordination |

Sub-agents appear in the office as separate characters and keep their
own conversation state.

## Production-readiness notes

This adapter includes the fixes that blocked the original Hermes PR:

- `chat.abort` now aborts only the requested `runId` or `sessionKey`
  instead of cancelling every active run
- history clears from `sessions.reset`, `agents.delete`, and
  `dismiss_agent` now persist to disk immediately
- `scripts/clawd3d-start.sh` no longer hardcodes one developer's local path

## ACP status

Hermes has a real ACP surface and that remains the preferred long-term
integration direction.

This branch does not replace the adapter with ACP yet. The current
production-ready path uses the adapter because it works with the existing
Claw3D gateway contract today and is ready for upstream testing now.

The runtime seam added in Studio is what makes an ACP-backed Hermes
provider feasible as a follow-up without reworking the whole UI again.

## Persistence

Adapter-owned gateway state is stored at:

```text
~/.hermes/claw3d-adapter-state.json
```

That state includes Claw3D-visible agents, session settings, adapter
config, skill enablement flags, and cron jobs. Set
`HERMES_ADAPTER_STATE_DIR` to store the same
`claw3d-adapter-state.json` file under a different directory. If the
state file contains corrupt JSON, the adapter logs a warning and falls
back to default state without deleting the bad file.

Conversation history is stored at:

```text
~/.hermes/clawd3d-history.json
```

It is loaded on startup and updated when conversations change.

Agent workspace files are stored in each agent's configured workspace, not in
the adapter state file. Creating an agent bootstraps `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, and `MEMORY.md` if they
do not already exist.

## Current limitations

- Hermes is integrated through the adapter path today, not yet through a
  dedicated native Studio provider implementation
- Exec approvals behavior still matches the current adapter compatibility
  contract, not a fully Hermes-native permissions model
- This path is intended to get Hermes working reliably now while the
  broader runtime-provider architecture continues to mature

For a planning-focused breakdown of the parity gaps versus the native
OpenClaw gateway path, see
[`docs/hermes-adapter-gap-analysis.md`](hermes-adapter-gap-analysis.md).

## When to use demo mode instead

If you only want to see the office boot without installing Hermes or
OpenClaw, use:

```bash
npm run demo-gateway
npm run dev
```

That starts a bundled mock gateway for a no-framework Claw3D demo.

## Using OpenClaw instead

If you want the OpenClaw path, do not run the Hermes adapter. Start
OpenClaw and point Claw3D at that gateway instead.
