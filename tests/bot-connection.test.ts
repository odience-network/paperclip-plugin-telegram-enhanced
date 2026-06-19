import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  BOT_CONNECTION_SCOPE,
  getBotConnectionRegistration,
  resolveBotToken,
  type TelegramBotConnectionState,
} from "../src/worker.js";

// ODIAA-726: the Telegram bot token is configured once per instance, not as a
// per-company secret. The bot connection lives in instance-scoped plugin state
// and is resolved ahead of the legacy `telegramBotTokenRef` company secret.
// These tests lock in the resolution precedence and the guarantee that the raw
// token never leaves the worker through the masked registration.

function mockCtx(opts: {
  state?: unknown;
  resolveSecret?: (ref: string) => Promise<string>;
}): PluginContext {
  return {
    state: {
      get: vi.fn(async () => opts.state ?? null),
      set: vi.fn(async () => undefined),
    },
    secrets: {
      resolve: vi.fn(opts.resolveSecret ?? (async () => "")),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

const instanceState: TelegramBotConnectionState = {
  botToken: "111:INSTANCE",
  botUsername: "instance_bot",
  botId: "111",
  updatedAt: "2026-06-20T00:00:00.000Z",
};

describe("instance-wide bot connection scope", () => {
  it("stores the connection in instance-scoped state, not company-scoped", () => {
    expect(BOT_CONNECTION_SCOPE.scopeKind).toBe("instance");
    expect(BOT_CONNECTION_SCOPE.stateKey).toBe("telegram.bot-connection.v1");
  });
});

describe("resolveBotToken precedence", () => {
  it("prefers the instance-state connection over the legacy secret ref", async () => {
    const resolveSecret = vi.fn(async () => "222:SECRET");
    const ctx = mockCtx({ state: instanceState, resolveSecret });

    const resolved = await resolveBotToken(ctx, {
      telegramBotTokenRef: "11111111-1111-4111-8111-111111111111",
    } as never);

    expect(resolved).toEqual({ token: "111:INSTANCE", source: "instance-state" });
    // Instance token wins, so we never touch the company-scoped secret store.
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("falls back to the legacy secret ref when no instance token is set", async () => {
    const resolveSecret = vi.fn(async () => "222:SECRET");
    const ctx = mockCtx({ state: null, resolveSecret });

    const resolved = await resolveBotToken(ctx, {
      telegramBotTokenRef: "11111111-1111-4111-8111-111111111111",
    } as never);

    expect(resolved).toEqual({ token: "222:SECRET", source: "config-secret-ref" });
    expect(resolveSecret).toHaveBeenCalledOnce();
  });

  it("returns null when neither an instance token nor a secret ref is configured", async () => {
    const ctx = mockCtx({ state: null });
    const resolved = await resolveBotToken(ctx, {} as never);
    expect(resolved).toBeNull();
  });

  it("returns null (does not throw) when the legacy secret cannot be resolved", async () => {
    const ctx = mockCtx({
      state: null,
      resolveSecret: async () => {
        throw new Error("kill switch: company secret-refs disabled");
      },
    });

    const resolved = await resolveBotToken(ctx, {
      telegramBotTokenRef: "11111111-1111-4111-8111-111111111111",
    } as never);

    expect(resolved).toBeNull();
  });
});

describe("getBotConnectionRegistration masking", () => {
  it("reports the instance connection without leaking the raw token", () => {
    const reg = getBotConnectionRegistration(instanceState, { telegramBotTokenRef: "" });
    expect(reg).toEqual({
      configured: true,
      source: "instance-state",
      botUsername: "instance_bot",
      botId: "111",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    // The masked registration must never carry the secret value.
    expect(JSON.stringify(reg)).not.toContain("111:INSTANCE");
  });

  it("reports the legacy secret-ref source without exposing identity", () => {
    const reg = getBotConnectionRegistration(
      { botToken: null, botUsername: null, botId: null, updatedAt: null },
      { telegramBotTokenRef: "11111111-1111-4111-8111-111111111111" },
    );
    expect(reg.configured).toBe(true);
    expect(reg.source).toBe("config-secret-ref");
    expect(reg.botUsername).toBeNull();
  });

  it("reports unconfigured when nothing is set", () => {
    const reg = getBotConnectionRegistration(
      { botToken: null, botUsername: null, botId: null, updatedAt: null },
      { telegramBotTokenRef: "" },
    );
    expect(reg).toEqual({
      configured: false,
      source: null,
      botUsername: null,
      botId: null,
      updatedAt: null,
    });
  });
});
