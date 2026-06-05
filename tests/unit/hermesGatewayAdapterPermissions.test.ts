import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type GatewayResponse<Payload = Record<string, unknown>> =
  | { type: "res"; ok: true; payload: Payload }
  | { type: "res"; ok: false; error: { code: string; message: string } };

type HermesAdapterModule = {
  handleMethod: (
    method: string,
    params: Record<string, unknown>,
    id: string,
    sendEvent: (frame: object) => void
  ) => Promise<GatewayResponse>;
};

type ExecApprovalsFile = {
  version: 1;
  defaults?: Record<string, unknown>;
  agents?: Record<string, unknown>;
};

type ExecApprovalsPayload = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
  enforcement: { mode: "stored-only"; enforced: false; runtime: "hermes" };
};

const originalHome = process.env.HOME;
const originalStateDir = process.env.HERMES_ADAPTER_STATE_DIR;
const tempHomes: string[] = [];

const sendEvent = () => {};

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-permissions-home-"));
  tempHomes.push(home);
  return home;
};

const importAdapter = async (home: string): Promise<HermesAdapterModule> => {
  vi.resetModules();
  process.env.HOME = home;
  delete process.env.HERMES_ADAPTER_STATE_DIR;
  return (await import("../../server/hermes-gateway-adapter.js")) as HermesAdapterModule;
};

const callGateway = async <Payload = Record<string, unknown>>(
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Payload> => {
  const response = await adapter.handleMethod(method, params, method, sendEvent);
  expect(response).toMatchObject({ type: "res", ok: true });
  return (response as { payload: Payload }).payload;
};

const callGatewayRaw = async (
  adapter: HermesAdapterModule,
  method: string,
  params: Record<string, unknown> = {}
) => adapter.handleMethod(method, params, method, sendEvent);

afterEach(() => {
  vi.resetModules();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.HERMES_ADAPTER_STATE_DIR;
  } else {
    process.env.HERMES_ADAPTER_STATE_DIR = originalStateDir;
  }

  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe("hermes-gateway-adapter stored-only permissions", () => {
  it("persists exec approvals and reports stored-only non-enforcement across reload", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);

    const initial = await callGateway<ExecApprovalsPayload>(adapter, "exec.approvals.get");
    expect(initial).toMatchObject({
      exists: true,
      path: path.join(home, ".hermes", "claw3d-adapter-state.json"),
      file: {
        version: 1,
        defaults: { security: "full", ask: "off", autoAllowSkills: true },
        agents: {},
      },
      enforcement: { mode: "stored-only", enforced: false, runtime: "hermes" },
    });

    const nextFile: ExecApprovalsFile = {
      version: 1,
      defaults: { security: "allowlist", ask: "always", autoAllowSkills: false },
      agents: {
        "agent-2": {
          security: "allowlist",
          ask: "always",
          allowlist: [{ pattern: "git status" }],
        },
      },
    };
    const setResult = await callGateway<{
      hash: string;
      enforcement: ExecApprovalsPayload["enforcement"];
    }>(adapter, "exec.approvals.set", {
      file: nextFile,
      baseHash: initial.hash,
    });

    expect(setResult.hash).not.toBe(initial.hash);
    expect(setResult.enforcement).toEqual({
      mode: "stored-only",
      enforced: false,
      runtime: "hermes",
    });

    adapter = await importAdapter(home);
    const afterReload = await callGateway<ExecApprovalsPayload>(adapter, "exec.approvals.get");
    expect(afterReload.file).toEqual(nextFile);
    expect(afterReload.hash).toBe(setResult.hash);
    expect(afterReload.enforcement).toEqual({
      mode: "stored-only",
      enforced: false,
      runtime: "hermes",
    });
  });

  it("rejects stale exec approvals writes with retryable message", async () => {
    const adapter = await importAdapter(makeHome());
    const first = await callGateway<ExecApprovalsPayload>(adapter, "exec.approvals.get");

    await callGateway(adapter, "exec.approvals.set", {
      file: { version: 1, agents: { main: { security: "full", ask: "off" } } },
      baseHash: first.hash,
    });

    const stale = await callGatewayRaw(adapter, "exec.approvals.set", {
      file: { version: 1, agents: {} },
      baseHash: first.hash,
    });

    expect(stale).toMatchObject({
      type: "res",
      ok: false,
      error: {
        code: "invalid_request",
        message: "exec approvals changed since last load; re-run exec.approvals.get and retry",
      },
    });
  });

  it("keeps exec approval resolve as a compatibility no-op without claiming enforcement", async () => {
    const adapter = await importAdapter(makeHome());

    const result = await callGateway<{
      ok: boolean;
      enforcement: ExecApprovalsPayload["enforcement"];
    }>(adapter, "exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });

    expect(result).toEqual({
      ok: true,
      enforcement: { mode: "stored-only", enforced: false, runtime: "hermes" },
    });
  });
});
