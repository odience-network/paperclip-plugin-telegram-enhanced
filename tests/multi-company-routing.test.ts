import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE, plugin } from "../src/worker.js";
import { handleCommand } from "../src/commands.js";

// ODIAA-2700 — company-correct routing. `send_to_telegram` (the agent-callable
// action AND tool) still resolved its chat from the single primary `config`
// (whichever company's `onConfigChanged` delivery landed last), even though
// `notify()` and the `/status` notification flags were already fixed per
// company under ODIAA-1930. These tests lock in the two-company contract for
// the paths that were still wrong: an agent run for company B never sends to
// company A's chat, an unlinked chat never borrows either company's settings,
// and `/connect` lists every configured company from a cache rather than a
// live `companies.list` call the polling loop can't make.

const COMPANY_A = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";
const COMPANY_B = "b6b2b5a1-2222-4e3a-bbe3-3cd355f73b65";
const BOT_TOKEN = "111:INSTANCE";

const harnesses: TestHarness[] = [];

async function startWorker(): Promise<{
  harness: TestHarness;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const harness = createTestHarness({ manifest });
  harnesses.push(harness);

  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  harness.ctx.http.fetch = fetchMock as unknown as typeof harness.ctx.http.fetch;

  await harness.ctx.state.set(BOT_CONNECTION_SCOPE, {
    botToken: BOT_TOKEN,
    botUsername: "instance_bot",
    botId: "111",
    updatedAt: "2026-07-29T00:00:00.000Z",
  });

  harness.seed({
    companies: [
      { id: COMPANY_A, name: "Odience", issuePrefix: "ODIAA" },
      { id: COMPANY_B, name: "Acme", issuePrefix: "ACME" },
    ] as never,
  });

  await plugin.definition.setup(harness.ctx);
  return { harness, fetchMock };
}

function sendMessageCalls(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes("/sendMessage"))
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

function sentChatIds(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return sendMessageCalls(fetchMock).map((body) => String(body.chat_id));
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.emit("plugin.stopping" as never, {});
  }
  vi.restoreAllMocks();
});

describe("multi-company routing (ODIAA-2700)", () => {
  it("an agent run for company B never sends to company A's chat via send_to_telegram", async () => {
    const { harness, fetchMock } = await startWorker();

    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-1001-company-a" },
      { companyId: COMPANY_A } as never,
    );
    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-2002-company-b" },
      { companyId: COMPANY_B } as never,
    );

    const result = await harness.executeTool(
      "send_to_telegram",
      { text: "hello from B's agent" },
      { companyId: COMPANY_B, agentId: "agent-b" },
    );

    expect((result as { data?: { ok?: boolean; chatId?: string } }).data?.ok).toBe(true);
    expect((result as { data?: { chatId?: string } }).data?.chatId).toBe("-2002-company-b");
    const chatIds = sentChatIds(fetchMock);
    expect(chatIds).toEqual(["-2002-company-b"]);
  });

  it("the send_to_telegram action (non-tool callers) is equally company-scoped", async () => {
    const { harness, fetchMock } = await startWorker();

    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-1001-company-a" },
      { companyId: COMPANY_A } as never,
    );
    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-2002-company-b" },
      { companyId: COMPANY_B } as never,
    );

    await harness.performAction("send_to_telegram", { companyId: COMPANY_B, text: "hello" });

    const chatIds = sentChatIds(fetchMock);
    expect(chatIds).toEqual(["-2002-company-b"]);
  });

  it("an unlinked private chat gets the not-linked reply instead of any company's settings", async () => {
    const { harness, fetchMock } = await startWorker();

    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-1001-company-a" },
      { companyId: COMPANY_A } as never,
    );
    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-2002-company-b" },
      { companyId: COMPANY_B } as never,
    );

    // A brand-new private chat — never ran /connect — asks for /status.
    await handleCommand(harness.ctx, BOT_TOKEN, "999888777", "status", "");

    const chatIds = sentChatIds(fetchMock);
    expect(chatIds).toEqual(["999888777"]);
    expect(String(sendMessageCalls(fetchMock)[0]!.text)).toContain("not linked");
  });

  it("/connect lists both configured companies before either has produced a notification", async () => {
    const { harness, fetchMock } = await startWorker();

    // Config delivery only — no notification has gone out for either company.
    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-1001-company-a" },
      { companyId: COMPANY_A } as never,
    );
    await plugin.definition.onConfigChanged?.(
      { defaultChatId: "-2002-company-b" },
      { companyId: COMPANY_B } as never,
    );

    // Simulate /connect running from the polling loop, where the host refuses
    // the wildcard `companies.list` call (ODIAA-1927) — the only source for
    // the company list is the directory cache.
    harness.ctx.companies.list = vi.fn(async () => {
      throw new Error(
        'not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope',
      );
    });

    await handleCommand(harness.ctx, BOT_TOKEN, "555444333", "connect", "");

    const chatIds = sentChatIds(fetchMock);
    expect(chatIds).toEqual(["555444333"]);
    const text = String(sendMessageCalls(fetchMock)[0]!.text);
    expect(text).toContain("Odience");
    expect(text).toContain("Acme");
  });
});
