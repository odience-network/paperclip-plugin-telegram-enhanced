import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate } from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * ODIAA-1927 — a delivered reply must be acknowledged, and the answer to it must
 * come back as a reply to *that* message.
 *
 * Both halves were reported from the same chat: a reply landed with no sign it
 * had been read, and minutes later the agent's answer arrived threaded under the
 * bot's original card instead of under the question it answered.
 */

let sentMessages: Array<{ chatId: string; text: string }> = [];
let reactions: Array<{ messageId: number; emoji: string }> = [];
let reactionSucceeds = true;
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
    setMessageReaction: vi.fn(
      async (_ctx: unknown, _token: string, _chatId: string, messageId: number, emoji: string) => {
        reactions.push({ messageId, emoji });
        return reactionSucceeds;
      },
    ),
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
    issues: {
      createComment: vi.fn(async () => {}),
      get: vi.fn(async () => ({ id: "iss-579", status: "in_progress", assigneeAgentId: "agent-1" })),
      update: vi.fn(async () => {}),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
    },
    access: {
      members: {
        list: vi.fn(async () => [
          { principalType: "user", principalId: "local-board", status: "active" },
        ]),
      },
    },
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
  reactions = [];
  reactionSucceeds = true;
  stateStore = {
    "msg_-100777_157": {
      entityType: "issue",
      entityId: "iss-579",
      companyId: "co-1",
    },
    // The bot's original card for this issue — the anchor before the reply.
    "anchor_-100777_issue_iss-579": { messageId: 157, messageThreadId: undefined },
  };
});

describe("acknowledging a delivered reply (ODIAA-1927)", () => {
  it("reacts to the sender's message so they know it landed", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, replyUpdate("please retry"), "http://localhost:3100");

    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(reactions).toEqual([{ messageId: 5001, emoji: "👀" }]);
    // A reaction is enough; it must not also post a message into the chat.
    expect(sentMessages).toHaveLength(0);
  });

  it("says it in words when Telegram refuses the reaction", async () => {
    reactionSucceeds = false;
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, replyUpdate("please retry"), "http://localhost:3100");

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toContain("Got it");
  });
});

describe("threading the answer under the reply (ODIAA-1927)", () => {
  it("re-anchors the issue thread on the board member's message", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, replyUpdate("please retry"), "http://localhost:3100");

    expect(stateStore["anchor_-100777_issue_iss-579"]).toEqual({
      messageId: 5001,
      messageThreadId: undefined,
    });
  });

  it("leaves the anchor alone when the reply could not be delivered", async () => {
    stateStore["msg_-100777_157"] = {
      entityType: "approval",
      entityId: "app-1",
      companyId: "co-1",
    };
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, replyUpdate("please retry"), "http://localhost:3100");

    expect(stateStore["anchor_-100777_issue_iss-579"]).toEqual({
      messageId: 157,
      messageThreadId: undefined,
    });
    expect(reactions).toHaveLength(0);
  });
});
