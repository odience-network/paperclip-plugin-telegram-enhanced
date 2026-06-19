import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleCallbackQuery } from "../src/worker.js";
import { answerCallbackQuery, editMessage } from "../src/telegram-api.js";

// Ported from tue-Jonas `tests/callback-query.test.ts` (TWX-328: handle stale
// Telegram interaction callbacks) onto our worker/commands layout. Our enhanced
// fork routes decisions through the approvals API (`approve_` / `reject_`
// inline buttons) rather than tue-Jonas's generic interactions-api split, so the
// stale-callback scenario is a button press on an approval that is no longer
// pending — already decided through another channel, expired, or resolved in the
// opposite direction. The approvals service answers that with a 422 ("Only
// pending or revision requested approvals can be approved/rejected"); the press
// must be acknowledged gracefully instead of surfacing a raw API error.

const telegramMocks = vi.hoisted(() => ({
  answerCallbackQuery: vi.fn(async () => undefined),
  editMessage: vi.fn(async () => true),
}));

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    answerCallbackQuery: telegramMocks.answerCallbackQuery,
    editMessage: telegramMocks.editMessage,
  };
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockCtx(response: Response): PluginContext {
  return {
    http: {
      fetch: vi.fn(async () => response),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function callbackQuery(data = "approve_apr-1"): Parameters<typeof handleCallbackQuery>[2] {
  return {
    id: "callback-1",
    data,
    from: { id: 101, first_name: "Thomas", username: "thomas" },
    message: {
      message_id: 202,
      chat: { id: 303, type: "private" },
    },
  } as unknown as Parameters<typeof handleCallbackQuery>[2];
}

// A non-loopback base URL forces fetchPaperclipApi through ctx.http.fetch so the
// mocked response is deterministic (loopback URLs use global fetch instead).
const BASE_URL = "https://paperclip.example.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleCallbackQuery (stale decision callbacks)", () => {
  it("acknowledges an already-resolved approval without surfacing a raw conflict", async () => {
    const ctx = mockCtx(
      jsonRes(
        { error: "Only pending or revision requested approvals can be approved" },
        422,
      ),
    );

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BASE_URL, "pcp_board_test");

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "callback-1",
      "Already resolved",
    );
    expect(editMessage).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "303",
      202,
      "This decision was already resolved\\.",
      { parseMode: "MarkdownV2" },
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignored stale Telegram decision callback",
      expect.objectContaining({ kind: "approval_approve", id: "apr-1" }),
    );
  });

  it("acknowledges an already-resolved rejection the same way", async () => {
    const ctx = mockCtx(
      jsonRes(
        { error: "Only pending or revision requested approvals can be rejected" },
        422,
      ),
    );

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("reject_apr-9"), BASE_URL, "pcp_board_test");

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "callback-1",
      "Already resolved",
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignored stale Telegram decision callback",
      expect.objectContaining({ kind: "approval_reject", id: "apr-9" }),
    );
  });

  it("continues to surface non-stale conflicts as failures", async () => {
    const ctx = mockCtx(
      jsonRes(
        {
          error:
            "Cannot approve: the issue's most recent run has not completed workspace_finalize.",
        },
        409,
      ),
    );

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BASE_URL, "pcp_board_test");

    expect(editMessage).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    const [, , , message] = telegramMocks.answerCallbackQuery.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      string,
    ];
    expect(message).toMatch(/^Failed: /);
    expect(message).toContain("workspace_finalize");
  });

  it("confirms a successful approval as Approved", async () => {
    const ctx = mockCtx(jsonRes({ id: "apr-1", status: "approved" }, 200));

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BASE_URL, "pcp_board_test");

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "callback-1",
      "Approved",
    );
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      "Ignored stale Telegram decision callback",
      expect.anything(),
    );
  });
});
