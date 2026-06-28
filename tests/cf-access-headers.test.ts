import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleCallbackQuery } from "../src/worker.js";

// ODIAA-742: behind Cloudflare Access, plugin→board API calls must carry the
// service-token CF-Access-Client-Id / CF-Access-Client-Secret pair, or Access
// rejects them with a login challenge and the Approve/Reject action silently
// fails. These tests drive the real callback handler (telegram-api is NOT
// mocked) so every outbound request flows through ctx.http.fetch and we can
// assert exactly which hosts receive the CF-Access headers.

const BOARD_URL = "https://paperclip.example.com";
const TELEGRAM_HOST = "https://api.telegram.org";

const CF_HEADERS = { clientId: "cf-id.access", clientSecret: "cf-secret" } as const;

type FetchCall = { url: string; init: RequestInit | undefined };

function recordingCtx(calls: FetchCall[]): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        // Telegram endpoints expect a JSON `{ ok: true }` envelope; the board
        // approve/reject endpoints only have their body read on non-2xx.
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function callbackQuery(data = "approve_apr-1"): Parameters<typeof handleCallbackQuery>[2] {
  return {
    id: "callback-1",
    data,
    from: { id: 101, first_name: "Thomas", username: "thomas" },
    message: { message_id: 202, chat: { id: 303 } },
  } as unknown as Parameters<typeof handleCallbackQuery>[2];
}

function headersFor(calls: FetchCall[], hostPrefix: string): Record<string, string> {
  const call = calls.find((c) => c.url.startsWith(hostPrefix));
  expect(call, `expected a fetch to ${hostPrefix}`).toBeTruthy();
  return (call!.init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF Access service-token headers on board API calls (ODIAA-742)", () => {
  it("attaches CF-Access headers to the board approve call when refs resolve", async () => {
    const calls: FetchCall[] = [];
    const ctx = recordingCtx(calls);

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BOARD_URL, "pcp_board", CF_HEADERS);

    const boardHeaders = headersFor(calls, `${BOARD_URL}/api/approvals/`);
    expect(boardHeaders["CF-Access-Client-Id"]).toBe("cf-id.access");
    expect(boardHeaders["CF-Access-Client-Secret"]).toBe("cf-secret");
    expect(boardHeaders.Authorization).toBe("Bearer pcp_board");
  });

  it("attaches CF-Access headers to the board reject call when refs resolve", async () => {
    const calls: FetchCall[] = [];
    const ctx = recordingCtx(calls);

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("reject_apr-9"), BOARD_URL, "pcp_board", CF_HEADERS);

    const boardHeaders = headersFor(calls, `${BOARD_URL}/api/approvals/`);
    expect(boardHeaders["CF-Access-Client-Id"]).toBe("cf-id.access");
    expect(boardHeaders["CF-Access-Client-Secret"]).toBe("cf-secret");
  });

  it("omits CF-Access headers from the board call when no refs are configured", async () => {
    const calls: FetchCall[] = [];
    const ctx = recordingCtx(calls);

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BOARD_URL, "pcp_board");

    const boardHeaders = headersFor(calls, `${BOARD_URL}/api/approvals/`);
    expect(boardHeaders).not.toHaveProperty("CF-Access-Client-Id");
    expect(boardHeaders).not.toHaveProperty("CF-Access-Client-Secret");
    expect(boardHeaders.Authorization).toBe("Bearer pcp_board");
  });

  it("NEVER attaches CF-Access headers to api.telegram.org requests", async () => {
    const calls: FetchCall[] = [];
    const ctx = recordingCtx(calls);

    await handleCallbackQuery(ctx, "telegram-token", callbackQuery("approve_apr-1"), BOARD_URL, "pcp_board", CF_HEADERS);

    const telegramCalls = calls.filter((c) => c.url.startsWith(TELEGRAM_HOST));
    expect(telegramCalls.length).toBeGreaterThan(0);
    for (const call of telegramCalls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("CF-Access-Client-Id");
      expect(headers).not.toHaveProperty("CF-Access-Client-Secret");
      expect(headers).not.toHaveProperty("Authorization");
    }
  });
});
