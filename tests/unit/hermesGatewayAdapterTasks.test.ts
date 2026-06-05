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

type GatewayTaskRecord = {
  id: string;
  title: string;
  description?: string | null;
  status: "todo" | "in_progress" | "blocked" | "review" | "done";
  source?: string;
  assignedAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
  notes?: string[];
  archived?: boolean;
};

const originalHome = process.env.HOME;
const originalStateDir = process.env.HERMES_ADAPTER_STATE_DIR;
const tempHomes: string[] = [];

const sendEvent = () => {};

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tasks-home-"));
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

describe("hermes-gateway-adapter task store", () => {
  it("creates updates filters deletes and persists gateway tasks", async () => {
    const home = makeHome();
    let adapter = await importAdapter(home);

    const created = await callGateway<GatewayTaskRecord>(adapter, "tasks.create", {
      title: "Ship Hermes task board",
      description: "Make the adapter back the Kanban UI.",
      assignedAgentId: "hermes",
      notes: ["created from test"],
    });

    expect(created).toMatchObject({
      title: "Ship Hermes task board",
      description: "Make the adapter back the Kanban UI.",
      status: "todo",
      source: "claw3d_manual",
      assignedAgentId: "hermes",
      notes: ["created from test"],
      archived: false,
    });
    expect(created.id).toMatch(/^task-/);
    expect(Date.parse(created.createdAt)).toBeGreaterThan(0);
    expect(Date.parse(created.updatedAt)).toBeGreaterThan(0);

    const updated = await callGateway<GatewayTaskRecord>(adapter, "tasks.update", {
      id: created.id,
      status: "review",
      title: "Ship Hermes task board MVP",
      notes: ["ready for review"],
      archived: true,
    });
    expect(updated).toMatchObject({
      id: created.id,
      title: "Ship Hermes task board MVP",
      status: "review",
      notes: ["ready for review"],
      archived: true,
    });

    let listed = await callGateway<{ tasks: GatewayTaskRecord[] }>(adapter, "tasks.list", {
      includeArchived: false,
    });
    expect(listed.tasks).toEqual([]);

    adapter = await importAdapter(home);
    listed = await callGateway<{ tasks: GatewayTaskRecord[] }>(adapter, "tasks.list", {
      includeArchived: true,
    });
    expect(listed.tasks).toEqual([expect.objectContaining({ id: created.id, archived: true })]);

    const removed = await callGateway<{ ok: boolean; removed: boolean }>(adapter, "tasks.delete", {
      id: created.id,
    });
    expect(removed).toEqual({ ok: true, removed: true });
    const afterDelete = await callGateway<{ tasks: GatewayTaskRecord[] }>(adapter, "tasks.list", {
      includeArchived: true,
    });
    expect(afterDelete.tasks).toEqual([]);
  });

  it("rejects invalid task writes", async () => {
    const adapter = await importAdapter(makeHome());

    const createResponse = await callGatewayRaw(adapter, "tasks.create", { title: "   " });
    expect(createResponse).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "invalid_request" },
    });

    const updateResponse = await callGatewayRaw(adapter, "tasks.update", {
      id: "missing-task",
      status: "review",
    });
    expect(updateResponse).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "not_found" },
    });
  });
});
