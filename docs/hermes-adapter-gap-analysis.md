# Hermes Adapter Gap Analysis

This note records the current gap between the bundled Hermes gateway adapter
and the native OpenClaw gateway path. It is intended as planning input for
future Hermes parity work, not as an implementation spec.

Captured: 2026-06-04.

## Current Model

The native OpenClaw path treats OpenClaw as the runtime source of truth. Agent
records, sessions, config, approvals, workspaces, agent files, sandboxing, task
state, cron/heartbeat behavior, and runtime events belong to the gateway.
Claw3D reads and mutates that state through gateway APIs.

The Hermes path is different. `server/hermes-gateway-adapter.js` exposes a
Claw3D-compatible WebSocket gateway facade and forwards model calls to Hermes
through:

- `GET /v1/models`
- `POST /v1/chat/completions`

The adapter owns a local registry for Claw3D-visible agents. These agents are
not Hermes profiles. They are adapter-level conversation and visualization
subjects used to make Hermes behave like a multi-agent gateway. As of Iteration
1, that adapter-owned registry is backed by a local durable state file rather
than process memory alone.

## What Works Today

The adapter supports the main office and chat path:

- Gateway connection handshake with `adapterType: "hermes"`
- Agent list/create/update/delete
- Session list/preview/patch/reset/history
- Chat send, streaming deltas, targeted abort, and run wait
- Hermes model listing
- Basic skill status scanning from workspace and managed skill directories
- Basic cron list/add/remove/patch/run shape
- Durable adapter state for agents, session settings, config, skill enablement,
  and cron jobs
- Real `config.get`, `config.set`, and `config.patch` with deterministic hashes
  and stale-write rejection
- Stored-only `exec.approvals.get`, `exec.approvals.set`, and
  `exec.approval.resolve` compatibility metadata that is persisted but not
  enforced by Hermes
- Real workspace-backed `agents.files.get`, `agents.files.list`, and
  `agents.files.set`
- Workspace bootstrap for the seven Claw3D agent brain files:
  `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`,
  `HEARTBEAT.md`, and `MEMORY.md`
- Main-agent orchestration tools:
  - `spawn_agent`
  - `delegate_task`
  - `list_team`
  - `configure_agent`
  - `dismiss_agent`
  - `read_agent_context`

Conversation history is persisted at:

```text
~/.hermes/clawd3d-history.json
```

Adapter-owned state is persisted at:

```text
~/.hermes/claw3d-adapter-state.json
```

`HERMES_ADAPTER_STATE_DIR` can move that adapter state file to another
directory.

## Major Gaps And Compromises

| Rank | Gap or compromise | Necessity | Difficulty | Planning judgment |
|---:|---|---|---|---|
| 1 | Adapter-owned agents, config, session settings, skill flags, and cron jobs previously lived mostly in process memory. | P0 | M | Addressed by Iteration 1 durable state; keep this as the foundation for later parity work. |
| 2 | `config.get`, `config.patch`, and `config.set` previously reported success without preserving a real OpenClaw-like config model. | P0 | M | Addressed by Iteration 1 persisted config plus deterministic hash/baseHash behavior. |
| 3 | `agents.files.*` was backed by an in-memory map. OpenClaw creates real workspaces and bootstrap files; Hermes previously only reported paths for many flows. | P0/P1 | M | Addressed by Iteration 2 real workspace files and brain-file bootstrap. |
| 4 | Exec approvals, command security, tool allow/deny policy, and sandboxing are not enforced like OpenClaw. `exec.approvals.*` is a stored-only compatibility surface in Hermes mode. | P0 | S-XL | Addressed by Iteration 3 honest stored-only semantics; full PI/sandbox parity remains a larger runtime project. |
| 5 | `skills.install` is not implemented. `skills.update` only toggles an in-memory flag, and packaged install relies on a special `chat.send` path for file writes. | P1 | M | Implement after real workspace files exist. |
| 6 | Task board support is incomplete. The adapter exposes `tasks.list` as an empty list but does not implement `tasks.create`, `tasks.update`, or `tasks.delete`. | P1 | M | A local durable task store would unlock the office task UI for Hermes. |
| 7 | Cron and heartbeat behavior is mostly simulated. Cron jobs are in memory, and `cron.run` marks a job successful without running a real scheduled chat workload. | P1/P2 | L | Implement after durable state and task storage. Cron should trigger `chat.send` and emit meaningful runtime events. |
| 8 | Usage and cost analytics are missing. The frontend calls `sessions.usage` and `usage.cost`, but the adapter does not implement them. | P2 | M/L | A history-derived MVP is possible; real cost accounting depends on Hermes response metadata. |
| 9 | Hermes is not a native Studio provider or ACP-backed provider yet. It is a gateway-shaped adapter. | Strategic P2 | XL | Important long term, but too broad for the next parity slice. |

## Recommended Iteration Route

### Iteration 1: Durable Adapter State And Real Config

Goal: make the adapter stateful in a way that can survive restart and can be
validated by the existing Studio UI.

Scope:

- Introduce a small `HermesAdapterStore`.
- Persist:
  - agents
  - session settings
  - config
  - skill enablement
  - cron jobs
- Keep conversation history loading compatible with the existing
  `clawd3d-history.json` file.
- Make `config.get`, `config.patch`, and `config.set` read and write the real
  adapter config.
- Support config hash and `baseHash` behavior enough to preserve retry safety.

Suggested verification:

- Unit test create/update/delete agent followed by store reload.
- Unit test config write/read and stale hash failure.
- Unit test session settings persistence.

### Iteration 2: Real Workspace And Agent Files

Goal: make Hermes-visible agents behave like real workspace-backed gateway
agents from Claw3D's point of view.

Scope:

- Have `agents.create` create the configured workspace directory.
- Bootstrap core files such as:
  - `AGENTS.md`
  - `SOUL.md`
  - `IDENTITY.md`
  - `USER.md`
  - `TOOLS.md`
  - `HEARTBEAT.md`
  - `MEMORY.md`
- Move `agents.files.get`, `agents.files.list`, and `agents.files.set` to real
  filesystem reads and writes inside each agent workspace.
- Preserve path validation so adapter file operations cannot escape the agent
  workspace.

Suggested verification:

- Unit test file read/write/list across adapter restart.
- Unit test path traversal rejection.
- Unit test identity recovery from `IDENTITY.md`.

### Iteration 3: Honest Permissions Semantics

Goal: stop presenting Hermes as enforcing OpenClaw-level authority when it does
not.

Scope:

- Mark Hermes permissions as stored-only metadata, not enforced runtime policy.
- Persist `exec.approvals.*` data in the adapter state file so settings can be
  read back and migrated later.
- Remove Hermes from the runtime `approvals` capability because it does not
  emit or enforce real exec approval events.
- Keep the Capabilities UI usable for policy metadata, but show a Hermes-only
  warning that command approvals, web access, file tool access, and sandboxing
  are not enforced.
- Avoid returning approval responses that imply real command sandbox
  enforcement.

Suggested verification:

- Unit test Hermes capability derivation and settings display.
- Unit test that stored policy can be read back without claiming enforcement.

### Iteration 4: Skills, Tasks, Cron, And Heartbeat

Goal: make higher-level office workflows useful on Hermes once the state and
workspace foundations are reliable.

Scope:

- Implement first-class `skills.install`.
- Persist `skills.update`.
- Implement `tasks.create`, `tasks.update`, and `tasks.delete`.
- Persist cron jobs.
- Make `cron.run` invoke the target agent/session instead of only marking the
  job done.
- Add meaningful `cron` and `heartbeat` event emission.

Suggested verification:

- Unit test task CRUD.
- Unit test skill install writes expected files.
- Unit test cron run creates a chat run and updates job state.

### Iteration 5: Usage Analytics MVP

Goal: support the analytics panels with best-effort data.

Scope:

- Implement `sessions.usage` from persisted conversation/session history.
- Implement `usage.cost` as either:
  - zero-cost summary when Hermes lacks metadata, or
  - metadata-derived cost when Hermes responses include token/cost details.

Suggested verification:

- Unit test usage summaries across agents and date ranges.
- Unit test empty cost data is explicit and stable.

### Iteration 6: Native Hermes Provider Or ACP Path

Goal: replace the compatibility facade with a deeper Hermes integration when
the adapter has already proven the needed product semantics.

Scope:

- Evaluate Hermes ACP support as the long-term integration boundary.
- Decide whether Claw3D should keep the gateway-shaped adapter, add a native
  Studio provider, or support both.
- Avoid breaking existing `hermes` runtime profile settings.

## Non-Goals For The Next Slice

- Do not try to fully reimplement OpenClaw PI, sandbox, and approvals in the
  first parity slice.
- Do not make Hermes adapter agents pretend to be Hermes profiles unless Hermes
  exposes a real profile API that can own those records.
- Do not add a second frontend-only source of truth for agent records. If the
  adapter is the gateway boundary, its store should be the boundary-owned
  source of truth for Hermes mode.

## Open Questions

- What is the intended Hermes-native persistence model for agents or profiles,
  if any?
- Does Hermes expose token usage or cost metadata in chat completion responses?
- Should Hermes mode hide OpenClaw-only permissions UI, or show it as
  read/write configuration that is not runtime-enforced?
- If a future native Hermes provider replaces the adapter, should it migrate
  existing state from `~/.hermes/claw3d-adapter-state.json` or treat that file
  as adapter-only compatibility state?
