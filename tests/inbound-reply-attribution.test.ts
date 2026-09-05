import { describe, expect, it, vi } from "vitest";
import { routeInboundReply } from "../src/worker.js";
import {
  isAttributionRejection,
  pickSoleHumanMember,
  resolveConfiguredActor,
} from "../src/inbound-attribution.js";

/**
 * ODIAA-1927 — an inbound reply must be posted *as the board member*.
 *
 * A comment the plugin posts under its own identity renders as a system message
 * and, by host design, never wakes the assignee. That is what "the message I
 * sent in reply appears as a system message and is not taken as a comment to
 * process" meant. These tests pin the identity resolution and the two behaviors
 * that follow from it: the human-attributed comment, and the reopen of a
 * finished task so the reply is actually picked up.
 */

const CHAT = "-100777";

function makeCtx(options: {
  members?: Array<{ principalType: string; principalId: string; status: string }>;
  issue?: { status: string; assigneeAgentId: string | null } | null;
  createComment?: (...args: unknown[]) => Promise<void>;
} = {}) {
  const commentCalls: Array<{ issueId: string; text: string; companyId: string; options?: unknown }> = [];
  const updates: Array<{ issueId: string; patch: unknown }> = [];
  const wakeups: string[] = [];
  const ctx = {
    state: { async get() { return { entityType: "issue", entityId: "iss-1", companyId: "co-1" }; } },
    issues: {
      async createComment(issueId: string, text: string, companyId: string, opts?: unknown) {
        if (options.createComment) await options.createComment(issueId, text, companyId, opts);
        commentCalls.push({ issueId, text, companyId, options: opts });
      },
      async get() {
        return options.issue === undefined
          ? { id: "iss-1", status: "done", assigneeAgentId: "agent-1" }
          : options.issue;
      },
      async update(issueId: string, patch: unknown) {
        updates.push({ issueId, patch });
      },
      async requestWakeup(issueId: string) {
        wakeups.push(issueId);
        return { queued: true, runId: null };
      },
    },
    access: {
      members: {
        async list() {
          return options.members ?? [
            { principalType: "user", principalId: "local-board", status: "active" },
            { principalType: "agent", principalId: "agent-1", status: "active" },
          ];
        },
      },
    },
    metrics: { async write() {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { ctx: ctx as never, commentCalls, updates, wakeups };
}

const CONFIG = { enableInbound: true } as never;

function makeReply(chatType = "supergroup", fromId = 42) {
  return {
    message_id: 5001,
    from: { id: fromId, username: "boardmember" },
    chat: { id: Number(CHAT), type: chatType },
    text: "please continue",
    reply_to_message: { message_id: 157, from: { id: 1, is_bot: true } },
  } as never;
}

describe("inbound reply attribution (ODIAA-1927)", () => {
  it("posts the reply as the company's only human member when no mapping is configured", async () => {
    const { ctx, commentCalls } = makeCtx();

    const outcome = await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(commentCalls[0].options).toEqual({ actorUserId: "local-board" });
    expect(outcome).toMatchObject({ routed: "issue", attributedUserId: "local-board" });
  });

  it("prefers an explicit telegramActorMappings entry over every inference", async () => {
    const { ctx, commentCalls } = makeCtx();
    const config = {
      enableInbound: true,
      telegramActorMappings: { "42": "user-mapped" },
    } as never;

    await routeInboundReply(ctx, "token", config, makeReply(), CHAT, "please continue");

    expect(commentCalls[0].options).toEqual({ actorUserId: "user-mapped" });
  });

  it("leaves the comment unattributed when the company has more than one human", async () => {
    const { ctx, commentCalls } = makeCtx({
      members: [
        { principalType: "user", principalId: "user-a", status: "active" },
        { principalType: "user", principalId: "user-b", status: "active" },
      ],
    });

    const outcome = await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(commentCalls[0].options).toBeUndefined();
    expect(outcome).toMatchObject({ routed: "issue", attributedUserId: null });
  });

  it("still delivers the reply when the host refuses the attribution", async () => {
    const rejectAttributed = vi.fn(async (_id: unknown, _text: unknown, _co: unknown, opts?: unknown) => {
      if (opts) {
        throw new Error(
          'Plugin "telegram" is missing required capability "issue.comments.create_human_attributed" for method "issues.createComment"',
        );
      }
    });
    const { ctx, commentCalls } = makeCtx({ createComment: rejectAttributed as never });

    const outcome = await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(commentCalls).toHaveLength(1); // the attributed attempt threw before recording
    expect(commentCalls[0].options).toBeUndefined();
    expect(outcome).toMatchObject({ routed: "issue", attributedUserId: null });
  });

  it("reports a genuine delivery failure instead of silently degrading", async () => {
    const explode = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const { ctx } = makeCtx({ createComment: explode as never });

    const outcome = await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(outcome).toEqual({ routed: "none", reason: "delivery-failed" });
  });
});

describe("reopening a finished task from a reply (ODIAA-1927)", () => {
  it("moves a done issue back to todo and wakes its agent", async () => {
    const { ctx, updates, wakeups } = makeCtx();

    await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(updates).toEqual([{ issueId: "iss-1", patch: { status: "todo" } }]);
    expect(wakeups).toEqual(["iss-1"]);
  });

  it("leaves an open issue alone — the host already wakes the assignee", async () => {
    const { ctx, updates, wakeups } = makeCtx({
      issue: { status: "in_progress", assigneeAgentId: "agent-1" },
    });

    await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(updates).toEqual([]);
    expect(wakeups).toEqual([]);
  });

  it("never reopens a closed issue that has no agent to wake", async () => {
    const { ctx, updates, wakeups } = makeCtx({
      issue: { status: "done", assigneeAgentId: null },
    });

    await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(updates).toEqual([]);
    expect(wakeups).toEqual([]);
  });

  it("does not reopen when the comment stayed unattributed", async () => {
    const { ctx, updates, wakeups } = makeCtx({ members: [] });

    await routeInboundReply(ctx, "token", CONFIG, makeReply(), CHAT, "please continue");

    expect(updates).toEqual([]);
    expect(wakeups).toEqual([]);
  });
});

describe("actor resolution rules", () => {
  const userChatMappings = { "user-dm": "555", "user-other": "999" };

  it("reverse-resolves a private chat whose id is the sender's own id", () => {
    expect(
      resolveConfiguredActor({ userChatMappings }, { fromId: 555, chatId: "555", chatType: "private" }),
    ).toEqual({ userId: "user-dm", source: "user_chat_mapping" });
  });

  it("never reverse-resolves a group chat, where the id proves nothing about the sender", () => {
    expect(
      resolveConfiguredActor(
        { userChatMappings: { "user-dm": CHAT } },
        { fromId: 42, chatId: CHAT, chatType: "supergroup" },
      ),
    ).toEqual({ userId: null, source: "unresolved" });
  });

  it("ignores a private chat id that is not the sender's own id", () => {
    expect(
      resolveConfiguredActor({ userChatMappings }, { fromId: 42, chatId: "555", chatType: "private" }),
    ).toEqual({ userId: null, source: "unresolved" });
  });

  it("picks the sole active human, ignoring agents and inactive members", () => {
    expect(
      pickSoleHumanMember([
        { principalType: "agent", principalId: "agent-1", status: "active" },
        { principalType: "user", principalId: "user-a", status: "active" },
        { principalType: "user", principalId: "user-b", status: "suspended" },
      ]),
    ).toBe("user-a");
    expect(pickSoleHumanMember([])).toBeNull();
  });

  it("classifies host attribution refusals, not transport failures", () => {
    expect(isAttributionRejection(new Error('missing required capability "issue.comments.create_human_attributed"'))).toBe(true);
    expect(isAttributionRejection(new Error('actorUserId "u1" is not an active human member of this company'))).toBe(true);
    expect(isAttributionRejection(new Error('actorUserId "u1" has viewer (read-only) access and cannot take this write action'))).toBe(true);
    expect(isAttributionRejection(new Error("connection reset"))).toBe(false);
  });
});
