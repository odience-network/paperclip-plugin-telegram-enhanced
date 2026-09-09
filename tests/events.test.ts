import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { emitOrLog } from "../src/events.js";

function mockCtx(emit: (...args: unknown[]) => unknown): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit },
  } as unknown as PluginContext;
}

describe("emitOrLog", () => {
  it("awaits ctx.events.emit and forwards the event, companyId, and payload", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const ctx = mockCtx(emit);

    await emitOrLog(ctx, "acp-spawn", "company-1", { type: "spawn", sessionId: "s1" }, "session spawn");

    expect(emit).toHaveBeenCalledWith("acp-spawn", "company-1", { type: "spawn", sessionId: "s1" });
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("logs (and does not throw) when the emit promise rejects", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("host unavailable"));
    const ctx = mockCtx(emit);

    await expect(
      emitOrLog(ctx, "acp-spawn", "company-1", { type: "message", sessionId: "s1" }, "message routing", { sessionId: "s1" }),
    ).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith("Failed to emit host event", {
      event: "acp-spawn",
      type: "message",
      site: "message routing",
      companyId: "company-1",
      sessionId: "s1",
      error: "Error: host unavailable",
    });
  });

  it("logs (and does not throw) when ctx.events.emit throws synchronously", async () => {
    // A bare `.catch()` on the call only guards a rejected promise — it does
    // nothing if the host RPC proxy throws before ever returning one (e.g.
    // an uninitialized transport). emitOrLog must catch that case too.
    const emit = vi.fn(() => {
      throw new Error("transport not initialized");
    });
    const ctx = mockCtx(emit);

    await expect(
      emitOrLog(ctx, "escalation.resolved", "company-1", { escalationId: "esc-1" }, "escalation resolved"),
    ).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith("Failed to emit host event", {
      event: "escalation.resolved",
      type: undefined,
      site: "escalation resolved",
      companyId: "company-1",
      error: "Error: transport not initialized",
    });
  });
});
