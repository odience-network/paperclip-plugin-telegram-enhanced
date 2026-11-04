import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE, plugin } from "../src/worker.js";

// ODIAA-2700 — health must say *why* nothing is being delivered. Before this
// fix, onHealth() defaulted to "ok" even with zero bot tokens configured, so
// every outbound notification silently failed with no operator-visible cause.

const harnesses: TestHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.emit("plugin.stopping" as never, {});
  }
  vi.restoreAllMocks();
});

async function startWorker(): Promise<TestHarness> {
  const harness = createTestHarness({ manifest });
  harnesses.push(harness);
  harness.ctx.http.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof harness.ctx.http.fetch;
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("onHealth", () => {
  it("reports degraded with 'no bot connected' when no token is configured", async () => {
    await startWorker();

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toBe("no bot connected");
  });

  it("reports ok once a bot token is connected", async () => {
    const harness = await startWorker();

    await harness.performAction("telegram-connection.update", { token: "999:LIVE" });

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });

  it("reports degraded again after the bot connection is cleared", async () => {
    const harness = await startWorker();
    await harness.performAction("telegram-connection.update", { token: "999:LIVE" });
    expect((await plugin.definition.onHealth?.())?.status).toBe("ok");

    await harness.performAction("telegram-connection.clear", {});

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toBe("no bot connected");
  });

  it("reports ok once config delivery resolves the instance-state bot token", async () => {
    const harness = await startWorker();
    await harness.ctx.state.set(BOT_CONNECTION_SCOPE, {
      botToken: "999:LIVE",
      botUsername: "instance_bot",
      botId: "999",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });

    await plugin.definition.onConfigChanged?.({ defaultChatId: "-1001" }, {
      companyId: "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64",
    } as never);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });
});
