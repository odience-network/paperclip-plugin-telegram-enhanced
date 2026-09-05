import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate } from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * ODIAA-1927 — a reply the plugin cannot deliver must be answered, not dropped.
 *
 * Silently ignoring an unroutable reply is exactly what "the bot never receives
 * my answers" looked like from the chat: the message was read, matched nothing,
 * and the board member was never told.
 */

let sentMessages: Array<{ chatId: string; text: string }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn(async () => {}) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    companies: { get: vi.fn().mockResolvedValue(null) },
    issues: { createComment: vi.fn(async () => {}) },
  } as unknown as PluginContext;
}

const CHAT = -100777;

const config = {
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
} as unknown as Parameters<typeof handleUpdate>[2];

function replyUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 5001,
      from: { id: 42, username: "boardmember" },
      chat: { id: CHAT, type: "supergroup" },
      text,
      reply_to_message: {
        message_id: 157,
        from: { id: 1, is_bot: true },
        chat: { id: CHAT, type: "supergroup" },
      },
    },
  } as unknown as Parameters<typeof handleUpdate>[3];
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
});

describe("unroutable inbound replies (ODIAA-1927)", () => {
  it("tells the board member when the replied-to notification is too old to answer", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, replyUpdate("ok, do it"), "http://localhost:3100");

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("too old to answer");
    expect(ctx.metrics.write).toHaveBeenCalledWith("telegram_inbound_unrouted", 1);
  });

  it("stays silent for ordinary chatter that is not a reply to the bot", async () => {
    const ctx = mockCtx();
    const chatter = replyUpdate("just talking");
    delete (chatter as { message?: { reply_to_message?: unknown } }).message?.reply_to_message;

    await handleUpdate(ctx, "token", config, chatter, "http://localhost:3100");

    expect(sentMessages).toHaveLength(0);
  });

  it("says nothing extra when the reply was delivered", async () => {
    stateStore["msg_-100777_157"] = {
      entityType: "heartbeat_run",
      entityId: "run-77",
      issueId: "iss-579",
      companyId: "co-1",
    };
    const ctx = mockCtx();

    await handleUpdate(ctx, "token", config, replyUpdate("retry please"), "http://localhost:3100");

    expect(ctx.issues.createComment).toHaveBeenCalledWith("iss-579", "retry please", "co-1");
    expect(sentMessages).toHaveLength(0);
  });
});
