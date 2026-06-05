# Hermes Profile-Native Iteration Plan

Status: Iteration 1 implemented on 2026-06-05.

This document records the current Hermes adapter route after the first
profile-native slice. The goal is to reduce adapter simulation one iteration at
a time while keeping the Claw3D gateway facade stable for the frontend.

This plan supersedes the older agent-roster parts of
[`hermes-adapter-gap-analysis.md`](hermes-adapter-gap-analysis.md). That older
document is still useful for historical gap analysis, but this file is the
source of truth for the profile-native rollout order.

## Guiding Decisions

- Keep `server/hermes-gateway-adapter.js` as the public gateway entrypoint.
- Do not modify `./hermes-agent` from this repository.
- Prefer Hermes native concepts when Hermes exposes a stable API.
- Keep OpenClaw-shaped gateway method names stable to avoid broad frontend
  churn.
- Move one runtime surface per iteration. Do not mix sessions/chat/cron/skills
  migration into the profile-backed agents slice.
- Keep approvals and sandbox settings honest: Hermes mode may store Claw3D
  policy metadata, but it must not claim OpenClaw sandbox enforcement.

## Current Architecture

```text
Claw3D UI
  -> Claw3D gateway protocol
  -> Hermes gateway adapter
      -> Hermes HTTP API for chat/model compatibility
      -> Hermes Dashboard API for profile-backed agent roster
      -> adapter overlay state for Claw3D-only compatibility fields
```

When `HERMES_PROFILE_API_URL` is configured, Hermes profiles are the primary
source for `agents.list`. The adapter still owns compatibility overlays such
as heartbeat settings, stored-only permissions, UI overrides, and
orchestration-created adapter sub-agents.

When the Dashboard profile API is unavailable, the adapter logs a compat
fallback warning and reads the existing adapter-owned registry.

## Iteration 1: Profile-Backed Agents

Status: implemented.

Goal: make the Claw3D agent roster correspond to Hermes profiles instead of
using adapter state as the primary source for agents.

Implemented scope:

- Added a Hermes profile client backed by the Dashboard API.
- Read `HERMES_PROFILE_API_URL`.
- Read `HERMES_PROFILE_API_TOKEN`, falling back to
  `HERMES_DASHBOARD_SESSION_TOKEN`.
- Send `X-Hermes-Session-Token` on Dashboard API requests.
- Map `GET /api/profiles` to `agents.list`.
- Keep the default profile exposed as agent id `hermes`.
- Use named profile names as agent ids.
- Add `metadata.hermesProfileName` on profile-backed agent entries.
- Map profile `description` to the gateway agent `role`.
- Map explicit `agents.create` to `POST /api/profiles` with
  `clone_from_default: true`.
- Map `agents.update.role` to
  `PUT /api/profiles/{name}/description`.
- Map non-default `agents.update.name` to
  `PATCH /api/profiles/{name}` and return the new agent id.
- Map named profile deletion to `DELETE /api/profiles/{name}`.
- Reject deletion and rename of the default Hermes profile.
- Preserve adapter-owned orchestration sub-agents; `spawn_agent` does not
  create real Hermes profiles.
- Keep config get/set/patch as the Claw3D-only overlay surface.
- Preserve stored-only approval semantics.

Verification gates:

- `node -c server/hermes-gateway-adapter.js`
- `node -c server/hermes-adapter/*.js`
- `tests/unit/hermesGatewayAdapterProfiles.test.ts`
- `tests/unit/hermesGatewayAdapterState.test.ts`
- `tests/unit/hermesGatewayAdapterPermissions.test.ts`
- `tests/unit/hermesGatewayAdapterScheduler.test.ts`
- `tests/unit/hermesGatewayAdapterSkills.test.ts`
- `tests/unit/hermesGatewayAdapterSkillsInstall.test.ts`
- `tests/unit/gatewayConfigPatch.test.ts`
- `tests/unit/runtimeProviderCapabilities.test.ts`

## Iteration 2: Native Sessions And Chat

Status: planned.

Goal: move conversation/session behavior toward Hermes native session or run
APIs while keeping the gateway facade stable.

Candidate Hermes surfaces:

- `GET /api/sessions`
- Hermes chat stream endpoints, if profile-aware.
- `/v1/runs`, if it becomes the better run boundary.

Expected scope:

- Resolve the active Hermes profile for each gateway agent/session.
- Map `sessions.list`, `sessions.preview`, `sessions.reset`, and
  `chat.history` to Hermes session data where possible.
- Map `chat.send` to the most native Hermes streaming boundary available.
- Preserve gateway event shapes: `chat` deltas/final/error and `presence`.
- Keep adapter fallback only where Hermes lacks the needed native data.

Non-goals:

- Do not change profile CRUD again unless session APIs require profile
  selection metadata.
- Do not claim usage/cost precision unless Hermes returns reliable metadata.
- Do not migrate cron or skills in this iteration.

Validation focus:

- Profile-specific session isolation.
- Streaming event compatibility.
- Abort behavior.
- History reset semantics.
- Fallback behavior when Hermes native session data is unavailable.

## Iteration 3: Profile-Aware Cron

Status: planned.

Goal: map Claw3D cron jobs to Hermes profile-aware scheduled jobs rather than
adapter-only cron simulation.

Candidate Hermes surface:

- `GET /api/cron/jobs?profile=...`
- Profile-aware create/update/delete/run cron endpoints if available.

Expected scope:

- Resolve `agentId` to `metadata.hermesProfileName`.
- List profile-specific jobs through Dashboard cron APIs.
- Create, patch, remove, and run jobs through Hermes where supported.
- Preserve Claw3D gateway event shapes for `cron` and task/playbook events.
- Keep adapter overlay only for fields Hermes does not store.

Non-goals:

- Do not migrate sessions/chat in the same iteration.
- Do not invent scheduler guarantees that Hermes does not provide.

Validation focus:

- Job list by profile.
- Create/update/delete behavior.
- Manual run behavior.
- Event emission compatibility.
- Fallback or explicit unsupported behavior for missing Hermes cron APIs.

## Iteration 4: Native Skills And Toolsets

Status: planned.

Goal: reduce workspace skill simulation by reading profile-native skill and
toolset sources first.

Candidate Hermes surfaces:

- Profile directories.
- `/v1/skills`, if available and profile-aware.
- `/v1/toolsets`, if available and profile-aware.

Expected scope:

- Resolve skill status from the profile directory or Hermes native skill APIs.
- Prefer Hermes-native skill/toolset metadata over Claw3D workspace scans.
- Keep Claw3D packaged skill install compatibility only where it still maps to
  real profile files.
- Preserve user-visible enable/disable behavior without pretending Hermes
  enforces unavailable tool policies.

Non-goals:

- Do not make stored-only approvals look enforced.
- Do not mix this with native cron/session migration.

Validation focus:

- Skill status by profile.
- Toolset visibility by profile.
- Packaged skill install behavior.
- Existing permissions warning behavior.

## Deferred Strategic Work

These topics stay out of the current iteration series until the profile,
sessions/chat, cron, and skills surfaces have clear behavior:

- Native Studio-side Hermes provider.
- ACP-backed Hermes provider.
- Full OpenClaw PI/sandbox parity.
- Automatic LLM orchestration that creates or deletes real Hermes profiles.
- Billing-grade usage and cost telemetry.

## Public Interface Contract

Environment variables:

- `HERMES_PROFILE_API_URL`
- `HERMES_PROFILE_API_TOKEN`
- `HERMES_DASHBOARD_SESSION_TOKEN` as token fallback

Gateway compatibility:

- Gateway method names remain unchanged.
- `agents.list` entries may include `metadata.hermesProfileName`.
- `agents.update` may return `previousAgentId`, `agentId`, and `newAgentId`
  when a profile rename changes the gateway agent id.

## Operational Assumptions

- The Hermes Dashboard API is reachable at `HERMES_PROFILE_API_URL`.
- The Dashboard accepts `X-Hermes-Session-Token`.
- The Dashboard token is either `HERMES_PROFILE_API_TOKEN` or
  `HERMES_DASHBOARD_SESSION_TOKEN`.
- Missing Dashboard profile CRUD is not patched in this repository.
- Automatic orchestration remains adapter-owned until explicitly changed.
