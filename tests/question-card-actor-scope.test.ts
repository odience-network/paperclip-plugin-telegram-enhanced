import { describe, it, expect, vi } from "vitest";
import { handleUpdate } from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// ODIAA-2700 — a typed reply to a question card used the *primary* config's
// `telegramActorMappings` (whichever company's `onConfigChanged` delivery
// landed last) instead of the card's own company. A cross-company mapping
// here is an authorization bug: it decides who may act on someone else's
// decision (see decision-routing.ts's threat model), not just a UX wrinkle.

const CHAT = "-100777";
const CARD_MESSAGE_ID = 5001;
const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const FROM_ID = 999;

let sentMessages: Array<{ chatId: string; text: string }>;
let stateStore: Record<string, unknown>;

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
  };
});

function mockCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
}

function replyUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 6001,
      from: { id: FROM_ID, username: "alice" },
      chat: { id: Number(CHAT), type: "supergroup" },
      text,
      reply_to_message: { message_id: CARD_MESSAGE_ID, from: { id: 1, is_bot: true } },
    },
  } as never;
}

describe("question card actor-mapping scope (ODIAA-2700)", () => {
  it("authorizes a typed card reply using the card's own company mapping, not the primary config", async () => {
    sentMessages = [];
    stateStore = {
      [`qcard_${CHAT}_${CARD_MESSAGE_ID}`]: {
        v: 1,
        kind: "request_confirmation",
        companyId: COMPANY_B,
        issueId: "iss-1",
        interactionId: "int-1",
        questions: [],
        selections: {},
        texts: {},
        context: { issueIdentifier: "ACME-1" },
        ownerUserId: "user-b",
      },
      [`msg_${CHAT}_${CARD_MESSAGE_ID}`]: { companyId: COMPANY_B },
    };
    const ctx = mockCtx();

    // The "primary" config (whichever company's onConfigChanged landed last)
    // does NOT know this Telegram user as "user-b" — only company B's own
    // config does. The pre-fix code read `config.telegramActorMappings` here
    // (the primary config), which would wrongly deny the real owner.
    const primaryConfig = {
      enableInbound: true,
      telegramActorMappings: {},
    } as never;
    const configFor = (companyId?: string | null) =>
      (companyId === COMPANY_B
        ? { enableInbound: true, telegramActorMappings: { [String(FROM_ID)]: "user-b" } }
        : primaryConfig) as never;

    await handleUpdate(
      ctx,
      "bot-token",
      primaryConfig,
      replyUpdate("yes"),
      "https://paperclip.example",
      undefined,
      undefined,
      configFor,
    );

    expect(sentMessages).toHaveLength(1);
    // Guard passed (company B's mapping matched the owner) and fell through to
    // settle(), which fails for an unrelated reason (no board token configured
    // in this test) — NOT "Not your decision.", which is what the primary
    // config's empty mapping would have produced.
    expect(sentMessages[0]!.text).not.toBe("Not your decision.");
    expect(sentMessages[0]!.text).toContain("Board access is not configured");
  });

  it("still denies the reply when the card's own company mapping does not match the owner", async () => {
    sentMessages = [];
    stateStore = {
      [`qcard_${CHAT}_${CARD_MESSAGE_ID}`]: {
        v: 1,
        kind: "request_confirmation",
        companyId: COMPANY_B,
        issueId: "iss-1",
        interactionId: "int-1",
        questions: [],
        selections: {},
        texts: {},
        context: { issueIdentifier: "ACME-1" },
        ownerUserId: "user-b",
      },
      [`msg_${CHAT}_${CARD_MESSAGE_ID}`]: { companyId: COMPANY_B },
    };
    const ctx = mockCtx();

    // Company A's mapping (wrongly) claims this Telegram user as "user-b" —
    // if the handler used company A's config for company B's card, it would
    // incorrectly allow the reply.
    const primaryConfig = {
      enableInbound: true,
      telegramActorMappings: { [String(FROM_ID)]: "user-b" },
    } as never;
    const configFor = (companyId?: string | null) =>
      (companyId === COMPANY_B
        ? { enableInbound: true, telegramActorMappings: {} }
        : primaryConfig) as never;

    await handleUpdate(
      ctx,
      "bot-token",
      primaryConfig,
      replyUpdate("yes"),
      "https://paperclip.example",
      undefined,
      undefined,
      configFor,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe("Not your decision.");
  });
});
