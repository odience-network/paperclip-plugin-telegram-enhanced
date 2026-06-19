import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getMe } from "../src/telegram-api.js";

// ODIAA-720: getMe validates a bot token before it is stored instance-wide.
function ctxWith(
  fetchImpl: (input: string) => Promise<{ json: () => Promise<unknown> }>,
): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch: fetchImpl },
  } as unknown as PluginContext;
}

describe("getMe", () => {
  it("returns the bot identity when Telegram accepts the token", async () => {
    let calledUrl = "";
    const ctx = ctxWith(async (url: string) => {
      calledUrl = url;
      return { json: async () => ({ ok: true, result: { id: 42, username: "my_bot", first_name: "My Bot" } }) };
    });

    const info = await getMe(ctx, "123:token");

    expect(info).toEqual({ id: 42, username: "my_bot", first_name: "My Bot" });
    expect(calledUrl).toContain("/bot123:token/getMe");
  });

  it("returns null when Telegram rejects the token", async () => {
    const ctx = ctxWith(async () => ({ json: async () => ({ ok: false }) }));
    expect(await getMe(ctx, "bad-token")).toBeNull();
  });

  it("returns null (does not throw) when the request fails", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("network down");
    });
    expect(await getMe(ctx, "123:token")).toBeNull();
  });
});
