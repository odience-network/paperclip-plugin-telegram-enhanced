import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE, notificationFlagsOf, plugin } from "../src/worker.js";

// ODIAA-1379 — company-scoped plugin configuration.
//
// paperclip host >= 2026.707.0 only resolves `config.get` inside a
// company-scoped invocation. `setup()` runs inside `initialize`, before any
// invocation exists, so the old `await ctx.config.get()` there was rejected with
//
//   Plugin "<id>" is not allowed to perform "config.get": company context is
//   required
//
// which failed worker initialize and made the whole plugin unactivatable. The
// host instead replays each configured company's config through `configChanged`
// right after the worker starts. These tests lock in both halves of that
// contract: setup() never reads config, and every config-derived behaviour
// follows the delivered config rather than whatever was true at registration.

const COMPANY_ID = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";
const BOT_TOKEN = "111:INSTANCE";

const harnesses: TestHarness[] = [];

/**
 * Build a harness whose `config.get` fails exactly the way the host's
 * governed-access gate does, so any read from setup() surfaces as a test
 * failure instead of silently passing on a permissive fake.
 */
async function startWorker(options: { withBotToken?: boolean } = {}) {
  const harness = createTestHarness({ manifest });
  harnesses.push(harness);

  const deniedConfigGet = vi.fn(async () => {
    throw new Error(
      `Plugin "${manifest.key}" is not allowed to perform "config.get": company context is required`,
    );
  });
  harness.ctx.config.get = deniedConfigGet as unknown as typeof harness.ctx.config.get;

  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  harness.ctx.http.fetch = fetchMock as unknown as typeof harness.ctx.http.fetch;

  if (options.withBotToken) {
    await harness.ctx.state.set(BOT_CONNECTION_SCOPE, {
      botToken: BOT_TOKEN,
      botUsername: "instance_bot",
      botId: "111",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
  }

  harness.seed({
    companies: [{ id: COMPANY_ID, name: "Odience", issuePrefix: "ODIAA" }] as never,
  });

  await plugin.definition.setup(harness.ctx);
  return { harness, deniedConfigGet, fetchMock };
}

function sentMessages(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/sendMessage"));
}

afterEach(async () => {
  // Stop the unconditional polling loop started by setup() so it does not keep
  // ticking across tests.
  for (const harness of harnesses.splice(0)) {
    await harness.emit("plugin.stopping" as never, {});
  }
  vi.restoreAllMocks();
});

describe("setup() under company-scoped config", () => {
  it("completes without reading company-scoped config", async () => {
    const { deniedConfigGet } = await startWorker();
    expect(deniedConfigGet).not.toHaveBeenCalled();
  });

  it("registers notification handlers before any config has been delivered", async () => {
    const { harness, fetchMock } = await startWorker({ withBotToken: true });

    // Handlers must exist at registration time even though the worker is still
    // running on DEFAULT_CONFIG — a registration-time `if (config.notifyOn…)`
    // gate would have dropped this subscription permanently.
    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueCreated: true,
    });
    await harness.emit("issue.created", { title: "Hello" }, { companyId: COMPANY_ID });

    expect(sentMessages(fetchMock)).toHaveLength(1);
  });
});

describe("onConfigChanged delivery", () => {
  it("applies a delivered notification flag without a worker restart", async () => {
    const { harness, fetchMock } = await startWorker({ withBotToken: true });

    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueCreated: false,
    });
    await harness.emit("issue.created", { title: "Suppressed" }, { companyId: COMPANY_ID });
    expect(sentMessages(fetchMock)).toHaveLength(0);

    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueCreated: true,
    });
    await harness.emit("issue.created", { title: "Delivered" }, { companyId: COMPANY_ID });
    expect(sentMessages(fetchMock)).toHaveLength(1);
  });

  it("suppresses task-complete notifications once the operator turns them off (ODIAA-1927)", async () => {
    const { harness, fetchMock } = await startWorker({ withBotToken: true });

    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueDone: false,
    });
    await harness.emit(
      "issue.updated",
      { status: "done", title: "Suppressed" },
      { companyId: COMPANY_ID, entityId: "issue-off" },
    );
    expect(sentMessages(fetchMock)).toHaveLength(0);

    await plugin.definition.onConfigChanged?.({
      defaultChatId: "-1001",
      notifyOnIssueDone: true,
    });
    await harness.emit(
      "issue.updated",
      { status: "done", title: "Delivered" },
      { companyId: COMPANY_ID, entityId: "issue-on" },
    );
    expect(sentMessages(fetchMock)).toHaveLength(1);
  });

  it("reports the delivered notification flags, not the defaults (ODIAA-1927)", async () => {
    await startWorker();

    // The `/status` readout is only diagnostic if it maps each flag to the key
    // the delivery-time gate reads — a crossed key would report "off" for a
    // notification that still fires.
    expect(
      notificationFlagsOf({
        notifyOnIssueCreated: true,
        notifyOnIssueDone: false,
        notifyOnIssueAssigned: false,
        notifyOnIssueBlocked: true,
        notifyOnBoardMention: false,
        notifyOnApprovalCreated: true,
        notifyOnAgentError: true,
        notifyOnAgentRunStarted: false,
        notifyOnAgentRunFinished: false,
      } as never),
    ).toEqual({
      issueCreated: true,
      issueDone: false,
      issueAssigned: false,
      issueBlocked: true,
      boardMention: false,
      approvalCreated: true,
      agentError: true,
      agentRunStarted: false,
      agentRunFinished: false,
    });
  });

  it("falls back to DEFAULT_CONFIG for keys the operator never saved", async () => {
    const { harness, fetchMock } = await startWorker({ withBotToken: true });

    // notifyOnIssueCreated is absent from the stored config; DEFAULT_CONFIG has
    // it on. Without the merge it would read `undefined` and silently suppress.
    await plugin.definition.onConfigChanged?.({ defaultChatId: "-1001" });
    await harness.emit("issue.created", { title: "Defaulted" }, { companyId: COMPANY_ID });

    expect(sentMessages(fetchMock)).toHaveLength(1);
  });

  it("logs the company scope the config was delivered for", async () => {
    const { harness } = await startWorker();

    await plugin.definition.onConfigChanged?.({ defaultChatId: "-1001" }, {
      companyId: COMPANY_ID,
    } as never);

    const applied = harness.logs.find((entry) => entry.message === "Telegram plugin config applied");
    expect(applied?.meta?.companyId).toBe(COMPANY_ID);
  });

  it("tolerates a host that delivers no company scope", async () => {
    const { harness } = await startWorker();

    await expect(
      plugin.definition.onConfigChanged?.({ defaultChatId: "-1001" }),
    ).resolves.toBeUndefined();

    const applied = harness.logs.find((entry) => entry.message === "Telegram plugin config applied");
    expect(applied?.meta?.companyId).toBeNull();
  });
});
