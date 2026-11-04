// Ported from mvanhorn/paperclip-plugin-telegram@8a0e579 (ODIAA-935).
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  SECRET_RESOLUTION_DISABLED_MESSAGE,
  SECRET_RESOLUTION_ISSUE_URL,
  resolveSecretRef,
  resolveStartupTelegramBotToken,
  type TelegramRuntimeHealth,
} from "../src/runtime-token.js";

function makeContext(resolve: () => Promise<string>): PluginContext {
  return {
    secrets: { resolve },
    logger: {
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("resolveStartupTelegramBotToken", () => {
  it("returns the resolved bot token and marks health ok", async () => {
    const health: TelegramRuntimeHealth[] = [];
    const ctx = makeContext(async () => "bot-token");

    const token = await resolveStartupTelegramBotToken(ctx, "secret-ref", (next) => health.push(next));

    expect(token).toBe("bot-token");
    expect(health).toEqual([{ status: "ok" }]);
  });

  it("degrades health and does not throw when Paperclip secret resolution fails", async () => {
    const health: TelegramRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error(SECRET_RESOLUTION_DISABLED_MESSAGE);
    });

    const token = await resolveStartupTelegramBotToken(ctx, "secret-ref", (next) => health.push(next));

    expect(token).toBeUndefined();
    expect(health).toEqual([{
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    }]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Telegram plugin cannot resolve bot token secret; runtime features are disabled",
      {
        error: `Error: ${SECRET_RESOLUTION_DISABLED_MESSAGE}`,
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    );
  });
});

describe("resolveSecretRef", () => {
  const UUID = "8d69a7fe-563c-4924-849e-01cb573f15e8";

  it("sends the secret_ref binding with company and config path on current hosts", async () => {
    const resolve = vi.fn(async () => "board-token");
    const ctx = makeContext(resolve);
    await expect(
      resolveSecretRef(ctx, UUID, { companyId: "co-1", configPath: "paperclipBoardApiTokenRef" }),
    ).resolves.toBe("board-token");
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: UUID },
      { companyId: "co-1", configPath: "paperclipBoardApiTokenRef" },
    );
  });

  it("falls back to the bare UUID for older hosts", async () => {
    const resolve = vi.fn(async (ref: unknown) => {
      if (typeof ref !== "string") throw new Error("unsupported ref");
      return "legacy-token";
    });
    await expect(resolveSecretRef(makeContext(resolve as never), UUID, { companyId: "co-1" })).resolves.toBe(
      "legacy-token",
    );
  });

  it("reports the current-host error when both shapes fail", async () => {
    const resolve = vi.fn(async (ref: unknown) => {
      throw new Error(typeof ref === "string" ? "Use { type: secret_ref }" : "Secret is not bound to plugin");
    });
    await expect(
      resolveSecretRef(makeContext(resolve as never), { type: "secret_ref", secretId: UUID }, { companyId: "co-1" }),
    ).rejects.toThrow("Secret is not bound to plugin");
  });

  it("rejects values that are not secret references", async () => {
    await expect(resolveSecretRef(makeContext(vi.fn()), "not-a-uuid")).rejects.toThrow("Invalid secret reference");
  });
});
