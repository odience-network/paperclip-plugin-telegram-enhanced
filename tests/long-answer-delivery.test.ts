import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE, plugin } from "../src/worker.js";

/**
 * ODIAA-1927 — an agent's answer must arrive whole.
 *
 * A long completion comment used to be cut at 300 characters, so the reader saw
 * an answer that stopped mid-sentence with no way to tell there was more. The
 * rest now follows as messages replying to the first one, which keeps the whole
 * answer in one Telegram thread and inside Telegram's 4096-character limit.
 */

const COMPANY_ID = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";
const harnesses: TestHarness[] = [];

async function startWorker() {
  const harness = createTestHarness({ manifest });
  harnesses.push(harness);

  let nextMessageId = 900;
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  harness.ctx.http.fetch = fetchMock as unknown as typeof harness.ctx.http.fetch;

  await harness.ctx.state.set(BOT_CONNECTION_SCOPE, {
    botToken: "111:INSTANCE",
    botUsername: "instance_bot",
    botId: "111",
    updatedAt: "2026-07-29T00:00:00.000Z",
  });
  harness.seed({
    companies: [{ id: COMPANY_ID, name: "Odience", issuePrefix: "ODIAA" }] as never,
  });

  await plugin.definition.setup(harness.ctx);
  return { harness, fetchMock };
}

/** The bodies of every sendMessage call, in order. */
function sentPayloads(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes("/sendMessage"))
    .map((call) => JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.emit("plugin.stopping" as never, {});
  }
  vi.restoreAllMocks();
});

describe("long agent answers (ODIAA-1927)", () => {
  it("continues a long completion comment in replies instead of truncating it", async () => {
    const { harness, fetchMock } = await startWorker();
    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueDone: true,
    });

    const paragraph = Array(150).fill("sentence").join(" ");
    const comment = Array(4).fill(paragraph).join("\n\n");
    await harness.emit(
      "issue.updated",
      { status: "done", title: "Long answer", comment },
      { companyId: COMPANY_ID, entityId: "issue-long" },
    );

    const sent = sentPayloads(fetchMock);
    expect(sent.length).toBeGreaterThan(1);

    // Every message fits Telegram's per-message limit ...
    for (const payload of sent) {
      expect(String(payload.text).length).toBeLessThanOrEqual(4096);
    }
    // ... the continuations all reply to the same first message, keeping the
    // answer as one thread rather than a run of loose messages ...
    expect(sent[0]!.reply_to_message_id).toBeUndefined();
    const replyTargets = new Set(sent.slice(1).map((payload) => payload.reply_to_message_id));
    expect(replyTargets.size).toBe(1);
    expect(typeof [...replyTargets][0]).toBe("number");
    // ... and the whole answer is delivered.
    const delivered = sent.map((payload) => String(payload.text)).join(" ");
    expect(delivered.split("sentence").length - 1).toBe(600);
  });

  it("keeps a short comment in a single message", async () => {
    const { harness, fetchMock } = await startWorker();
    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueDone: true,
    });

    await harness.emit(
      "issue.updated",
      { status: "done", title: "Short answer", comment: "Shipped and verified." },
      { companyId: COMPANY_ID, entityId: "issue-short" },
    );

    const sent = sentPayloads(fetchMock);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.text)).toContain("Shipped and verified");
  });
});
