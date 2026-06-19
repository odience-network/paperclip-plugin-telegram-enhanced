import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscalationManager } from "../src/escalation.js";
import type { EscalationEvent } from "../src/escalation.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 42;
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    }),
  };
});

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      emit: vi.fn((event: string, companyId: string, payload: unknown) => {
        emittedEvents.push({ event, companyId, payload });
      }),
    },
    agents: {
      get: vi.fn().mockResolvedValue(null),
      sessions: {
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
    },
  } as unknown as PluginContext;
}

function makeEvent(overrides: Partial<EscalationEvent> = {}): EscalationEvent {
  return {
    escalationId: "esc-001",
    agentId: "agent-1",
    companyId: "company-1",
    reason: "low_confidence",
    context: {
      conversationHistory: [{ role: "user", text: "Help me" }],
      agentReasoning: "I'm not sure about this",
      suggestedActions: ["Forward to support"],
      suggestedReply: "Let me connect you with a human.",
      confidenceScore: 0.3,
    },
    timeout: {
      durationMs: 60000,
      defaultAction: "defer",
    },
    originChatId: "origin-chat-1",
    originThreadId: "origin-thread-1",
    originMessageId: "origin-msg-1",
    transport: "native",
    sessionId: "session-1",
    ...overrides,
  };
}

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("EscalationManager.create", () => {
  it("sends an escalation message with MarkdownV2 formatting", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].chatId).toBe("esc-chat-1");
    expect(sentMessages[0].text).toContain("Escalation");
    expect(sentMessages[0].text).toContain("Low Confidence");
    expect(sentMessages[0].options).toMatchObject({ parseMode: "MarkdownV2" });
  });

  it("includes confidence score percentage", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      confidenceScore: 0.72,
    }}), "esc-chat-1");

    expect(sentMessages[0].text).toContain("72%");
  });

  it("omits confidence when not provided", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      confidenceScore: undefined,
    }}), "esc-chat-1");

    expect(sentMessages[0].text).not.toContain("%");
  });

  it("includes suggested reply button when suggestedReply is provided", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(keyboard).toBeDefined();
    // First row should be the suggested reply button
    const suggestedBtn = keyboard[0].find((b: { text: string }) => b.text === "Send Suggested Reply");
    expect(suggestedBtn).toBeDefined();
    expect(suggestedBtn!.callback_data).toBe("esc_suggested_esc-001");
  });

  it("omits suggested reply button when no suggestedReply", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      suggestedReply: undefined,
    }}), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b: { text: string }) => b.text === "Send Suggested Reply")).toBeUndefined();
  });

  it("always includes Reply, Override, and Dismiss buttons", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b: { text: string }) => b.text === "Reply")).toBeDefined();
    expect(allButtons.find((b: { text: string }) => b.text === "Override")).toBeDefined();
    expect(allButtons.find((b: { text: string }) => b.text === "Dismiss")).toBeDefined();
  });

  it("stores escalation state in ctx.state", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(stored.escalationId).toBe("esc-001");
    expect(stored.status).toBe("pending");
    expect(stored.agentId).toBe("agent-1");
    expect(stored.reason).toBe("low_confidence");
  });

  it("adds escalation id to pending list", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const pendingIds = stateStore["escalation_pending_ids"] as string[];
    expect(pendingIds).toContain("esc-001");
  });

  it("appends to existing pending list", async () => {
    stateStore["escalation_pending_ids"] = ["esc-000"];
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const pendingIds = stateStore["escalation_pending_ids"] as string[];
    expect(pendingIds).toEqual(["esc-000", "esc-001"]);
  });

  it("includes suggested actions in message", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: ["Action 1", "Action 2"],
    }}), "esc-chat-1");

    expect(sentMessages[0].text).toContain("Action 1");
    expect(sentMessages[0].text).toContain("Action 2");
  });

  it("maps all four escalation reasons to labels", async () => {
    const manager = new EscalationManager();

    for (const [reason, label] of [
      ["low_confidence", "Low Confidence"],
      ["explicit_request", "User Requested Human"],
      ["policy_violation", "Policy Violation"],
      ["unknown_intent", "Unknown Intent"],
    ] as const) {
      sentMessages = [];
      const ctx = mockCtx();
      await manager.create(ctx, "token", makeEvent({ reason }), "chat");
      expect(sentMessages[0].text).toContain(label.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&"));
    }
  });

  it("stores transport and sessionId in escalation state", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ transport: "acp", sessionId: "sess-acp" }), "esc-chat-1");

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.transport).toBe("acp");
    expect(stored.sessionId).toBe("sess-acp");
  });

  it("uses provided agentName in the escalation message and stored state", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ agentName: "Support Pilot" }), "esc-chat-1");

    expect(sentMessages[0].text).toContain("Support Pilot");
    expect(sentMessages[0].text).not.toContain("*Agent:* agent\\-1");
    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.agentName).toBe("Support Pilot");
  });

  it("resolves agent name from Paperclip when not provided", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    (ctx.agents.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "agent-1",
      name: "Resolution Lead",
    });

    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    expect(sentMessages[0].text).toContain("Resolution Lead");
  });
});

describe("EscalationManager.handleCallback - callback data parsing", () => {
  it("handles esc_suggested action with suggested reply", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "unsure",
      suggestedReply: "Here is help",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
      defaultAction: "defer",
    };

    await manager.handleCallback(ctx, "token", "suggested", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    // Should resolve and edit message
    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.status).toBe("resolved");
  });

  it("handles esc_reply action by editing message to awaiting reply", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "unsure",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
      defaultAction: "defer",
    };

    await manager.handleCallback(ctx, "token", "reply", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0].text).toContain("Awaiting your reply");
  });

  it("handles esc_dismiss action", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
      defaultAction: "defer",
    };

    await manager.handleCallback(ctx, "token", "dismiss", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.status).toBe("resolved");
  });

  it("ignores callback for non-pending escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      status: "resolved",
    };

    await manager.handleCallback(ctx, "token", "dismiss", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    // Nothing should happen
    expect(editedMessages.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });

  it("ignores callback for non-existent escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    await manager.handleCallback(ctx, "token", "dismiss", "nonexistent", "user-1", "cbq-1", "chat", 42);

    expect(editedMessages.length).toBe(0);
  });
});

describe("EscalationManager.checkTimeouts", () => {
  it("times out escalation that has exceeded timeout", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_pending_ids"] = ["esc-001"];
    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      timeoutAt: new Date(Date.now() - 60000).toISOString(), // already timed out
      defaultAction: "defer",
    };

    await manager.checkTimeouts(ctx, "token");

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.status).toBe("timed_out");
    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0].text).toContain("Timed Out");
  });

  it("does not time out escalation that has not exceeded timeout", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_pending_ids"] = ["esc-001"];
    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(), // future
      defaultAction: "defer",
    };

    await manager.checkTimeouts(ctx, "token");

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.status).toBe("pending");
    expect(editedMessages.length).toBe(0);
  });

  it("auto-replies on timeout when defaultAction is auto_reply", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_pending_ids"] = ["esc-001"];
    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedReply: "Auto response text",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      timeoutAt: new Date(Date.now() - 60000).toISOString(),
      defaultAction: "auto_reply",
      originChatId: "origin-chat",
    };

    await manager.checkTimeouts(ctx, "token");

    // Should have sent auto-reply to origin chat
    expect(sentMessages.some(m => m.chatId === "origin-chat")).toBe(true);
  });

  it("removes timed-out escalation from pending list", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_pending_ids"] = ["esc-001", "esc-002"];
    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      timeoutAt: new Date(Date.now() - 60000).toISOString(),
      defaultAction: "defer",
    };
    stateStore["escalation_esc-002"] = {
      escalationId: "esc-002",
      status: "pending",
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
      escalationChatId: "chat",
      escalationMessageId: "99",
      agentId: "a",
      companyId: "c",
      reason: "low_confidence",
      agentReasoning: "x",
      suggestedActions: [],
      createdAt: new Date().toISOString(),
      defaultAction: "defer",
    };

    await manager.checkTimeouts(ctx, "token");

    const pendingIds = stateStore["escalation_pending_ids"] as string[];
    expect(pendingIds).not.toContain("esc-001");
    expect(pendingIds).toContain("esc-002");
  });

  it("does nothing when pending list is empty", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    await manager.checkTimeouts(ctx, "token");

    expect(editedMessages.length).toBe(0);
    expect(sentMessages.length).toBe(0);
  });

  it("emits escalation.timed_out event", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_pending_ids"] = ["esc-001"];
    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      timeoutAt: new Date(Date.now() - 60000).toISOString(),
      defaultAction: "defer",
    };

    await manager.checkTimeouts(ctx, "token");

    expect(emittedEvents.some(e => e.event === "escalation.timed_out")).toBe(true);
  });
});

describe("EscalationManager.respond", () => {
  it("resolves a pending escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "low_confidence",
      agentReasoning: "test",
      suggestedActions: [],
      escalationChatId: "esc-chat-1",
      escalationMessageId: "42",
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
      defaultAction: "defer",
    };
    stateStore["escalation_pending_ids"] = ["esc-001"];

    await manager.respond(ctx, "token", "esc-001", {
      escalationId: "esc-001",
      responderId: "user-1",
      responseText: "Here is the answer",
      action: "reply_to_customer",
    });

    const stored = stateStore["escalation_esc-001"] as Record<string, unknown>;
    expect(stored.status).toBe("resolved");
  });

  it("ignores respond for non-pending escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    stateStore["escalation_esc-001"] = {
      escalationId: "esc-001",
      status: "resolved",
    };

    await manager.respond(ctx, "token", "esc-001", {
      escalationId: "esc-001",
      responderId: "user-1",
      responseText: "text",
      action: "reply_to_customer",
    });

    expect(editedMessages.length).toBe(0);
  });
});
