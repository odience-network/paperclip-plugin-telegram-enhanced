import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate } from "../src/worker.js";
import { processTelegramUpdateBatch } from "../src/polling-offset.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Regression coverage for the mvanhorn unlinked-chat fixes ported into this
// fork (48eeafc + 5f65627):
//  - Reliability: a resolveCompanyId throw must NOT escape handleUpdate. If it
//    did, the Telegram polling offset would never advance and the same update
//    would be re-fetched and re-thrown forever, wedging the poller for EVERY
//    chat (availability bug).
//  - Confidentiality: an unlinked chat must never have its raw numeric chatId
//    used as a companyId in API calls (cross-tenant misrouting / BEL-183).

let sentMessages: Array<{ chatId: string; text: string }> = [];
let stateStore: Record<string, unknown> = {};

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }),
    },
    metrics: { write: vi.fn(async () => {}) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    companies: { get: vi.fn().mockResolvedValue(null) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

const config = {
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
} as unknown as Parameters<typeof handleUpdate>[2];

// An unlinked group chat — no stateStore["chat_<id>"] mapping exists.
const UNLINKED_CHAT = 5851857072;

function statusCommandUpdate(update_id: number) {
  return {
    update_id,
    message: {
      message_id: 10,
      from: { id: 123 },
      chat: { id: UNLINKED_CHAT, type: "supergroup" },
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  };
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
});

describe("handleUpdate — unlinked chat", () => {
  it("does not throw for an unlinked /status command (poller-wedge guard)", async () => {
    const ctx = mockCtx();
    await expect(
      handleUpdate(ctx, "token", config, statusCommandUpdate(5), "http://localhost:3100"),
    ).resolves.toBeUndefined();
    // The company-scoped handler answered with its not-linked guidance...
    expect(sentMessages.some((m) => m.text.includes("Make sure this chat is linked"))).toBe(true);
    // ...and the raw chatId never reached the API as a companyId.
    expect(ctx.agents.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ companyId: String(UNLINKED_CHAT) }),
    );
  });

  it("advances the polling offset past an unlinked-chat command (no wedge)", async () => {
    const ctx = mockCtx();
    const finalOffset = await processTelegramUpdateBatch({
      updates: [statusCommandUpdate(5)],
      lastUpdateId: 4,
      handleUpdate: (u) => handleUpdate(ctx, "token", config, u, "http://localhost:3100"),
      persistOffset: async () => {},
      logger: ctx.logger,
    });
    // Offset moved forward: the poller will fetch the NEXT update, not re-loop.
    expect(finalOffset).toBe(5);
  });

  it("skips media from an unlinked chat without throwing or misrouting", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 6,
      message: {
        message_id: 11,
        from: { id: 123 },
        chat: { id: UNLINKED_CHAT, type: "supergroup" },
        voice: { file_id: "v-1", duration: 3 },
      },
    } as unknown as Parameters<typeof handleUpdate>[3];
    await expect(
      handleUpdate(ctx, "token", config, update, "http://localhost:3100"),
    ).resolves.toBeUndefined();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      "Ignoring media message from unlinked chat",
      { chatId: String(UNLINKED_CHAT) },
    );
  });

  it("skips thread routing from an unlinked chat without throwing", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 7,
      message: {
        message_id: 12,
        from: { id: 123 },
        chat: { id: UNLINKED_CHAT, type: "supergroup" },
        message_thread_id: 99,
        text: "hello agent",
      },
    } as unknown as Parameters<typeof handleUpdate>[3];
    await expect(
      handleUpdate(ctx, "token", config, update, "http://localhost:3100"),
    ).resolves.toBeUndefined();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      "Not routing thread message from unlinked chat",
      { chatId: String(UNLINKED_CHAT) },
    );
  });
});
