import { describe, expect, it } from "vitest";

import { HermesRuntimeProvider } from "@/lib/runtime/hermes/provider";
import { OpenClawRuntimeProvider } from "@/lib/runtime/openclaw/provider";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";

const createGatewayClient = () =>
  ({
    connect: async () => undefined,
    disconnect: () => undefined,
    call: async () => ({}),
    onStatus: () => () => undefined,
    onGap: () => () => undefined,
    onEvent: () => () => undefined,
  }) as unknown as GatewayClient;

describe("runtime provider capabilities", () => {
  it("does not advertise enforced approvals for Hermes", () => {
    const provider = new HermesRuntimeProvider(createGatewayClient());

    expect(provider.capabilities.has("approvals")).toBe(false);
  });

  it("keeps enforced approvals capability for OpenClaw", () => {
    const provider = new OpenClawRuntimeProvider(createGatewayClient());

    expect(provider.capabilities.has("approvals")).toBe(true);
  });
});
