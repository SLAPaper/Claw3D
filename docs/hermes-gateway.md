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
                                                        \-> Hermes Dashboard profile API
```

The frontend keeps using the Claw3D gateway protocol. The Hermes adapter
translates that protocol into Hermes HTTP calls and streams the results
back as gateway events.

Agent roster management now prefers Hermes native profiles. When
`HERMES_PROFILE_API_URL` is configured, `agents.list` is synthesized from
`GET /api/profiles`, explicit `agents.create/update/delete` calls map to the
Dashboard profile CRUD endpoints, and each listed agent includes
`metadata.hermesProfileName`. The default Hermes profile is still exposed as
agent id `hermes` for the main session; named profiles use the profile name as
their agent id.

The active profile-native rollout plan is documented in
[`docs/hermes-profile-native-iteration-plan.md`](hermes-profile-native-iteration-plan.md).
That plan is intentionally staged: Iteration 1 covers profile-backed agents,
while sessions/chat, cron, and skills/toolsets are separate follow-up
iterations.

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
HERMES_PROFILE_API_URL=http://127.0.0.1:9119
HERMES_PROFILE_API_TOKEN=
HERMES_ADAPTER_PORT=18789
HERMES_MODEL=hermes
HERMES_AGENT_NAME=Hermes
HERMES_ADAPTER_STATE_DIR=
```

`HERMES_PROFILE_API_TOKEN` is sent to the Dashboard API as
`X-Hermes-Session-Token`. If it is unset, the adapter falls back to
`HERMES_DASHBOARD_SESSION_TOKEN`.

The Hermes adapter loads environment files with `dotenv` in this order:

1. `.env.local`
2. `.env`

Existing process environment variables have higher priority than either file.
If a value seems "stuck", clear shell-level `Env:` variables or start a fresh
terminal session before running the adapter again.

When the adapter is running in development, `.env` and `.env.local` changes are
also watched and reloaded dynamically, with logs in the form:
`[hermes-adapter] Reload env: .env`.

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

`npm run build` only compiles the production Next.js app. It does not start
Studio, open `/api/gateway/ws`, or connect to Hermes. The Hermes adapter logs
runtime connection activity only when `npm run dev` or `npm run start` is
running and a Studio browser session connects through the gateway proxy.

If `.env` changes are not reflected, verify environment overrides first:

```powershell
Get-ChildItem Env:HERMES_ADAPTER_PORT,Env:HERMES_API_KEY
Remove-Item Env:HERMES_ADAPTER_PORT -ErrorAction SilentlyContinue
Remove-Item Env:HERMES_API_KEY -ErrorAction SilentlyContinue
```

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
- Profile-backed agent roster when the Hermes Dashboard profile API is
  configured
- Session listing, preview, patch, reset, and history lookup
- Chat send, targeted abort, and run wait
- Workspace-backed `agents.files.get/list/set` with bootstrap agent brain files
- Persisted config get/set/patch with hash protection for Studio writes
- Models and skills status
- Stored-only exec approvals metadata used by the current UI
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

These orchestration tools intentionally remain adapter-owned compatibility
tools in this iteration. `spawn_agent` does not automatically create or delete
real Hermes profiles; only explicit gateway/UI `agents.create/update/delete`
calls touch Dashboard profile CRUD.

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

Adapter-owned gateway overlay state is stored at:

```text
~/.hermes/claw3d-adapter-state.json
```

That state includes session settings, adapter config, stored-only exec
approvals metadata, skill enablement flags, cron jobs, and any adapter-owned
compatibility agents. When the Dashboard profile API is available, Hermes
profiles are the primary source for `agents.list`; the adapter state remains
the compatibility overlay for Claw3D-only fields such as heartbeat settings,
stored-only permissions, and UI overrides. Set
`HERMES_ADAPTER_STATE_DIR` to store the same
`claw3d-adapter-state.json` file under a different directory. If the
state file contains corrupt JSON, the adapter logs a warning and falls
back to default state without deleting the bad file.

If the profile API is configured but unavailable, the adapter logs
`Hermes profile API unavailable; using compat fallback` and falls back to the
adapter-owned registry for listing/config compatibility.

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
- Exec approvals, command permissions, tool policy, and sandbox settings are
  stored as compatibility metadata only. Hermes mode does not enforce them or
  emit real exec approval request/resolved events.
- `sessions.*`, `chat.send`, `cron.*`, skills, and toolsets still use the
  current compatibility layers. Planned follow-ups are to connect sessions/chat
  to Hermes native session/run APIs, cron to profile-aware Dashboard cron jobs,
  and skills/toolsets to profile directories or Hermes native endpoints.
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
