import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE, plugin } from "../src/worker.js";

// ODIAA-2699 — a question/confirmation card must be delivered exactly once,
// no matter how many of the three triggers (an agent run ending, the
// 5-minute sync job, and the legacy `issue.interaction.created` subscription
// — kept for hosts that do emit it) see the same pending interaction.

const COMPANY_ID = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";
const ISSUE_ID = "11111111-1111-1111-1111-111111111111";
const BOT_TOKEN = "111:INSTANCE";

const harnesses: TestHarness[] = [];

async function startWorker() {
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
    companies: [{ id: COMPANY_ID, name: "Odience", issuePrefix: "ODIAA" }] as never,
    issues: [
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "ODIAA-42",
        title: "Pick a database",
        status: "in_progress",
        projectId: null,
      },
    ] as never,
    issueInteractions: [
      {
        id: "int-1",
        issueId: ISSUE_ID,
        companyId: COMPANY_ID,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        resolverPolicy: "anyone",
        createdAt: new Date(),
        updatedAt: new Date(),
        payload: {
          version: 1,
          questionSet: {
            schema: "paperclip.question_set.v1",
            questions: [{ id: "db", prompt: "Which database?", answerMode: "single_select", required: true, options: [{ id: "pg", label: "Postgres" }] }],
          },
        },
      },
    ] as never,
  });

  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged?.({ defaultChatId: "-1001" }, { companyId: COMPANY_ID } as never);
  return { harness, fetchMock };
}

function sentMessageCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/sendMessage")).length;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.emit("plugin.stopping" as never, {});
  }
  vi.restoreAllMocks();
});

describe("question card delivery dedup (ODIAA-2699)", () => {
  it("delivers a pending interaction once even when the run-end and legacy triggers both see it", async () => {
    const { harness, fetchMock } = await startWorker();

    // Trigger 1: the agent's run ends on the issue that raised the question.
    await harness.emit(
      "agent.run.finished",
      { issueId: ISSUE_ID },
      { companyId: COMPANY_ID, entityType: "heartbeat_run", entityId: "run-1" },
    );
    // Trigger 2: the legacy subscription also fires for the same interaction
    // (a host that does emit `issue.interaction.created`).
    await harness.emit(
      "issue.interaction.created" as never,
      {},
      { companyId: COMPANY_ID, entityType: "issue", entityId: ISSUE_ID },
    );
    // Trigger 1 again: a duplicate re-emission of the same run-end event.
    await harness.emit(
      "agent.run.finished",
      { issueId: ISSUE_ID },
      { companyId: COMPANY_ID, entityType: "heartbeat_run", entityId: "run-1" },
    );

    expect(sentMessageCount(fetchMock)).toBe(1);
  });

  it("the 5-minute sync job never re-delivers a card already sent", async () => {
    const { harness, fetchMock } = await startWorker();

    await harness.emit(
      "agent.run.finished",
      { issueId: ISSUE_ID },
      { companyId: COMPANY_ID, entityType: "heartbeat_run", entityId: "run-1" },
    );
    expect(sentMessageCount(fetchMock)).toBe(1);

    await harness.runJob("sync-question-cards");
    expect(sentMessageCount(fetchMock)).toBe(1);
  });
});
