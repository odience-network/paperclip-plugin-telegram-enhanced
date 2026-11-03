import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleCardCallback, handleCardText, syncCards, type CardFlowDeps } from "../src/question-card-flow.js";
import {
  addOpenCard,
  cardFromInteraction,
  loadOpenCards,
  saveCard,
  setAwaitingText,
  toggleOption,
  type QuestionCard,
} from "../src/question-cards.js";

const tg = vi.hoisted(() => ({
  answerCallbackQuery: vi.fn(async () => undefined),
  editMessage: vi.fn(async () => true),
  sendMessage: vi.fn(async () => 999),
}));

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return { ...actual, ...tg };
});

const REF = { chatId: "42", messageId: 7 };

function makeCtx(interactions: Array<Record<string, unknown>> = []) {
  const state = new Map<string, unknown>();
  const posts: Array<{ url: string; body: unknown }> = [];
  const ctx = {
    state: {
      get: vi.fn(async (k: { stateKey: string }) => state.get(k.stateKey) ?? null),
      set: vi.fn(async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v)),
    },
    http: {
      fetch: vi.fn(async (url: string, init: { body?: string }) => {
        posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
        return new Response("{}", { status: 200 });
      }),
    },
    issues: { listInteractions: vi.fn(async () => interactions) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, posts, state };
}

function deps(ctx: PluginContext): CardFlowDeps {
  // Non-loopback base URL so calls go through the mocked ctx.http.
  return { ctx, token: "t", baseUrl: "https://pc.example", boardApiToken: "board" };
}

function questionCard(questions: unknown[]): QuestionCard {
  const card = cardFromInteraction(
    {
      id: "int-1",
      issueId: "iss-1",
      companyId: "co-1",
      kind: "ask_user_questions",
      payload: { questions },
    },
    { issueIdentifier: "XPL-7", agentName: "Ant" },
  )!;
  return { ...card, ...REF, deliveredAt: 0 };
}

const dbQuestion = {
  id: "db",
  prompt: "Which database?",
  selectionMode: "single",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "other", label: "Other", freeText: true },
  ],
};

const from = { id: 5, username: "mateusz" };

beforeEach(() => vi.clearAllMocks());

describe("handleCardCallback", () => {
  it("one tap sends the answer to Paperclip and closes the card", async () => {
    const { ctx, posts } = makeCtx();
    await saveCard(ctx, REF, questionCard([dbQuestion]));
    await addOpenCard(ctx, REF);

    const handled = await handleCardCallback(deps(ctx), { id: "cb", from }, REF, { type: "option", q: 0, o: 0 });

    expect(handled).toBe(true);
    expect(posts).toEqual([
      {
        url: "https://pc.example/api/issues/iss-1/interactions/int-1/respond",
        body: { answers: [{ questionId: "db", optionIds: ["pg"] }] },
      },
    ]);
    expect(tg.editMessage.mock.calls[0]![4]).toContain("Answered by mateusz");
    expect(await loadOpenCards(ctx)).toEqual([]);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(ctx, "t", "cb", "Sent");
  });

  it("a free-text option waits for a typed reply, then sends it", async () => {
    const { ctx, posts } = makeCtx();
    await saveCard(ctx, REF, questionCard([dbQuestion]));

    await handleCardCallback(deps(ctx), { id: "cb", from }, REF, { type: "option", q: 0, o: 1 });
    expect(posts).toEqual([]);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(ctx, "t", "cb", "Type your answer as a reply to this message");

    await handleCardText(deps(ctx), { message_id: 8, from }, REF, "MariaDB");
    expect(posts[0]!.body).toEqual({ answers: [{ questionId: "db", optionIds: ["other"], otherText: "MariaDB" }] });
  });

  it("refuses a press from someone who is not the owner", async () => {
    const { ctx, posts } = makeCtx();
    await saveCard(ctx, REF, { ...questionCard([dbQuestion]), ownerUserId: "user-a" });
    await handleCardCallback(
      { ...deps(ctx), telegramActorMappings: { "5": "user-b" } },
      { id: "cb", from },
      REF,
      { type: "option", q: 0, o: 0 },
    );
    expect(posts).toEqual([]);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(ctx, "t", "cb", "Not your decision");
  });

  it("tells the user when board access is missing instead of failing silently", async () => {
    const { ctx } = makeCtx();
    await saveCard(ctx, REF, questionCard([dbQuestion]));
    await handleCardCallback({ ...deps(ctx), boardApiToken: undefined }, { id: "cb", from }, REF, {
      type: "option",
      q: 0,
      o: 0,
    });
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "t",
      "cb",
      "Board access is not configured - connect it in the plugin settings.",
    );
  });

  it("returns false when the message has no card", async () => {
    const { ctx } = makeCtx();
    expect(await handleCardCallback(deps(ctx), { id: "cb", from }, REF, { type: "submit" })).toBe(false);
  });
});

describe("handleCardText", () => {
  it("rejects a confirmation with the typed reason", async () => {
    const { ctx, posts } = makeCtx();
    const card = cardFromInteraction(
      { id: "int-2", issueId: "iss-1", companyId: "co-1", kind: "request_confirmation", payload: { prompt: "Deploy?" } },
      { issueIdentifier: "XPL-7" },
    )!;
    await saveCard(ctx, REF, card);
    await handleCardText(deps(ctx), { message_id: 8, from }, REF, "Not before Friday");
    expect(posts[0]).toEqual({
      url: "https://pc.example/api/issues/iss-1/interactions/int-2/reject",
      body: { reason: "Not before Friday" },
    });
  });

  it("keeps collecting when more questions remain", async () => {
    const { ctx, posts } = makeCtx();
    await saveCard(ctx, REF, questionCard([dbQuestion, { ...dbQuestion, id: "host", prompt: "Where?" }]));
    await handleCardText(deps(ctx), { message_id: 8, from }, REF, "SQLite");
    expect(posts).toEqual([]);
    expect(tg.sendMessage.mock.calls[0]![3]).toBe("Noted. Still missing: Where?");
  });

  it("clears the awaiting marker once the typed answer is used", async () => {
    const { ctx, state } = makeCtx();
    const card = questionCard([dbQuestion]);
    toggleOption(card, 0, 1);
    await saveCard(ctx, REF, card);
    await setAwaitingText(ctx, REF.chatId, { messageId: REF.messageId, questionId: "db" });
    await handleCardText(deps(ctx), { message_id: 8, from }, REF, "MariaDB");
    expect(state.get("qcard_awaiting_text_42")).toEqual({ messageId: 0, questionId: "" });
  });
});

describe("syncCards", () => {
  it("closes a card answered in the board and reminds about an open one", async () => {
    const answeredRef = { chatId: "42", messageId: 1 };
    const openRef = { chatId: "42", messageId: 2 };
    const { ctx } = makeCtx([
      { id: "int-1", status: "answered", result: { answers: [{ questionId: "db", optionIds: ["pg"] }] } },
      { id: "int-3", status: "pending" },
    ]);
    await saveCard(ctx, answeredRef, { ...questionCard([dbQuestion]), ...answeredRef });
    await saveCard(ctx, openRef, { ...questionCard([dbQuestion]), ...openRef, interactionId: "int-3" });
    await addOpenCard(ctx, answeredRef);
    await addOpenCard(ctx, openRef);

    await syncCards(deps(ctx), { now: 3 * 3_600_000, reminder: () => ({ everyMinutes: 60, maxCount: 2 }) });

    expect(tg.editMessage).toHaveBeenCalledTimes(1);
    expect(tg.editMessage.mock.calls[0]![4]).toContain("Which database?: Postgres");
    expect(tg.editMessage.mock.calls[0]![4]).toContain("Answered in Paperclip");
    expect(await loadOpenCards(ctx)).toEqual([openRef]);
    expect(tg.sendMessage).toHaveBeenCalledWith(
      ctx,
      "t",
      "42",
      "⏰ Still waiting for your answer - XPL-7",
      { replyToMessageId: 2 },
    );
  });

  it("treats an interaction that disappeared as cancelled", async () => {
    const { ctx } = makeCtx([]);
    await saveCard(ctx, REF, questionCard([dbQuestion]));
    await addOpenCard(ctx, REF);
    await syncCards(deps(ctx));
    expect(tg.editMessage.mock.calls[0]![4]).toContain("Cancelled");
    expect(await loadOpenCards(ctx)).toEqual([]);
  });
});
