import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate, plugin } from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "../src/constants.js";

// ODIAA-1930 — `/status` must mirror the gates for the company the chat is
// linked to.
//
// `/status` reports the worker's live notification flags precisely so that a
// mismatch with the board's saved settings is visible (ODIAA-1927). That only
// holds if it reads the same per-company config the delivery gates read: with
// one worker serving every company, reading the instance-wide config made
// `/status` report a different company's settings.

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

const LINKED_CHAT = 4242;
const COMPANY_ID = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";

function mockCtx(opts: { secrets?: Record<string, string> } = {}): PluginContext {
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
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
    secrets: {
      resolve: vi.fn(async (binding: { secretId: string } | string) => {
        const secretId = typeof binding === "string" ? binding : binding.secretId;
        const resolved = opts.secrets?.[secretId];
        if (!resolved) throw new Error(`No such secret: ${secretId}`);
        return resolved;
      }),
    },
  } as unknown as PluginContext;
}

// The instance-wide view: inbound enabled, and every notification left at its
// default — "task complete" on.
const instanceConfig = {
  ...DEFAULT_CONFIG,
  enableCommands: true,
  enableInbound: true,
} as unknown as Parameters<typeof handleUpdate>[2];

function statusCommandUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 123 },
      chat: { id: LINKED_CHAT, type: "supergroup" },
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  };
}

beforeEach(() => {
  sentMessages = [];
  stateStore = { [`chat_${LINKED_CHAT}`]: { companyId: COMPANY_ID } };
});

describe("/status notification flags (ODIAA-1930)", () => {
  it("reports the linked company's flags, not the instance-wide config", async () => {
    const ctx = mockCtx();

    await handleUpdate(
      ctx,
      "111:TOKEN",
      instanceConfig,
      statusCommandUpdate(),
      "http://localhost:3100",
      undefined,
      undefined,
      // This company turned "task complete" off; the instance-wide config
      // still has it on.
      (companyId) =>
        companyId === COMPANY_ID
          ? ({ ...DEFAULT_CONFIG, notifyOnIssueDone: false } as unknown as Parameters<
              typeof handleUpdate
            >[2])
          : instanceConfig,
    );

    const status = sentMessages.map((m) => m.text).join("\n");
    expect(status).toContain("Notifications on:");
    expect(status).toContain("task created");
    expect(status).not.toContain("task complete");
  });

  it("falls back to the instance-wide config when no resolver is supplied", async () => {
    const ctx = mockCtx();

    await handleUpdate(
      ctx,
      "111:TOKEN",
      instanceConfig,
      statusCommandUpdate(),
      "http://localhost:3100",
    );

    expect(sentMessages.map((m) => m.text).join("\n")).toContain("task complete");
  });
});

// ODIAA-2699 — every board-API-token lookup must read the event/card's own
// company's config, and a missing token must be visible, not just a warn log.
describe("/status and onHealth board-token visibility (ODIAA-2699)", () => {
  const TOKEN_REF_A = "11111111-1111-1111-1111-111111111111";
  const OTHER_COMPANY_ID = "8f55e80b-0264-4ab6-9d56-8b2652f18005";

  it("reports the token configured for the linked company, not another company's", async () => {
    const ctx = mockCtx({ secrets: { [TOKEN_REF_A]: "resolved-token-A" } });
    // Company A has a board token configured; "another" company does not.
    const configFor = (companyId?: string | null) =>
      (companyId === COMPANY_ID
        ? { ...DEFAULT_CONFIG, paperclipBoardApiTokenRef: TOKEN_REF_A }
        : { ...DEFAULT_CONFIG }) as unknown as Parameters<typeof handleUpdate>[2];

    await handleUpdate(ctx, "111:TOKEN", instanceConfig, statusCommandUpdate(), "http://localhost:3100", undefined, undefined, configFor);
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("Board access: connected");

    sentMessages = [];
    stateStore = { [`chat_${LINKED_CHAT}`]: { companyId: OTHER_COMPANY_ID } };
    await handleUpdate(ctx, "111:TOKEN", instanceConfig, statusCommandUpdate(), "http://localhost:3100", undefined, undefined, configFor);
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("Board access: not configured");
  });

  it("surfaces a missing board token in onHealth(), not only a warn log", async () => {
    const ctx = mockCtx({ secrets: { [TOKEN_REF_A]: "resolved-token-A" } });
    stateStore = { [`chat_${LINKED_CHAT}`]: { companyId: OTHER_COMPANY_ID } };
    const configFor = () => ({ ...DEFAULT_CONFIG }) as unknown as Parameters<typeof handleUpdate>[2];

    await handleUpdate(ctx, "111:TOKEN", instanceConfig, statusCommandUpdate(), "http://localhost:3100", undefined, undefined, configFor);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).not.toBe("ok");
    expect(health?.details?.boardTokenMissingCompanyIds).toContain(OTHER_COMPANY_ID);
  });
});
