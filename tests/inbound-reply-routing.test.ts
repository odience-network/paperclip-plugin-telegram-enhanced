import { describe, expect, it } from "vitest";
import { routeInboundReply } from "../src/worker.js";

/**
 * ODIAA-936 — Org-routing invariant for inbound Telegram replies.
 *
 * Mirrors the intent of upstream tuejonas TWX-893 ("route Telegram replies to the
 * originating org") in our architecture: a reply must be delivered to the org that
 * sent the message it answers, sourced from the `companyId` persisted on the
 * outbound message mapping (`msg_<chat>_<message>`) — NEVER re-derived from the
 * chat-level company. In a shared/instance-wide chat (ODIAA-726) this is a
 * confidentiality guarantee, not just correctness.
 */

type StateKey = { scopeKind: string; stateKey: string };

function makeCtx(stateStore: Record<string, unknown>) {
  const commentCalls: Array<{ entityId: string; text: string; companyId: string }> = [];
  const metricCalls: Array<{ name: string; value: number }> = [];
  const ctx = {
    state: {
      async get(key: StateKey) {
        return stateStore[key.stateKey] ?? null;
      },
      async set(key: StateKey, value: unknown) {
        stateStore[key.stateKey] = value;
      },
    },
    issues: {
      async createComment(entityId: string, text: string, companyId: string) {
        commentCalls.push({ entityId, text, companyId });
      },
    },
    metrics: {
      async write(name: string, value: number) {
        metricCalls.push({ name, value });
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx: ctx as never, commentCalls, metricCalls };
}

const INBOUND_CONFIG = { enableInbound: true } as never;

function makeReply(text: string) {
  return {
    message_id: 5001,
    from: { id: 42, username: "boardmember" },
    chat: { id: -100777, type: "supergroup" },
    text,
    reply_to_message: {
      message_id: 157,
      from: { id: 1, is_bot: true },
      chat: { id: -100777, type: "supergroup" },
    },
  } as never;
}

describe("routeInboundReply org routing (ODIAA-936)", () => {
  it("routes an issue reply to the ORIGINATING org from the message mapping", async () => {
    const stateStore: Record<string, unknown> = {
      "msg_-100777_157": {
        entityType: "issue",
        entityId: "iss-579",
        // The org that produced the outbound notification — confidential target.
        companyId: "co-originating",
      },
    };
    const { ctx, commentCalls, metricCalls } = makeCtx(stateStore);

    const outcome = await routeInboundReply(
      ctx,
      "token",
      INBOUND_CONFIG,
      makeReply("Approved, ship it"),
      "-100777",
      "Approved, ship it",
    );

    expect(outcome).toEqual({ routed: "issue", entityId: "iss-579", companyId: "co-originating" });
    expect(commentCalls).toHaveLength(1);
    // The invariant: companyId comes from the mapping, not from the chat.
    expect(commentCalls[0]).toEqual({
      entityId: "iss-579",
      text: "Approved, ship it",
      companyId: "co-originating",
    });
    expect(metricCalls).toEqual([{ name: "telegram_inbound_routed", value: 1 }]);
  });

  it("never reuses one org's mapping for a different chat's reply (confidentiality)", async () => {
    // Two orgs share one chat (instance-wide token). Each outbound message keeps
    // its own companyId; the reply must follow the message it answers.
    const stateStore: Record<string, unknown> = {
      "msg_-100777_157": { entityType: "issue", entityId: "iss-a", companyId: "co-alpha" },
      "msg_-100777_158": { entityType: "issue", entityId: "iss-b", companyId: "co-beta" },
    };
    const { ctx, commentCalls } = makeCtx(stateStore);

    const replyToBeta = makeReply("looks good");
    (replyToBeta as { reply_to_message: { message_id: number } }).reply_to_message.message_id = 158;

    await routeInboundReply(ctx, "token", INBOUND_CONFIG, replyToBeta, "-100777", "looks good");

    expect(commentCalls).toEqual([{ entityId: "iss-b", text: "looks good", companyId: "co-beta" }]);
  });

  it("does nothing when inbound routing is disabled", async () => {
    const { ctx, commentCalls } = makeCtx({
      "msg_-100777_157": { entityType: "issue", entityId: "iss-579", companyId: "co-originating" },
    });
    const outcome = await routeInboundReply(
      ctx,
      "token",
      { enableInbound: false } as never,
      makeReply("hi"),
      "-100777",
      "hi",
    );
    expect(outcome).toEqual({ routed: "none" });
    expect(commentCalls).toHaveLength(0);
  });

  it("does nothing when the message is not a reply to a bot message", async () => {
    const { ctx, commentCalls } = makeCtx({});
    const nonReply = makeReply("hi");
    delete (nonReply as { reply_to_message?: unknown }).reply_to_message;
    const outcome = await routeInboundReply(ctx, "token", INBOUND_CONFIG, nonReply, "-100777", "hi");
    expect(outcome).toEqual({ routed: "none" });
    expect(commentCalls).toHaveLength(0);
  });

  it("does nothing when the replied-to message mapping has expired", async () => {
    const { ctx, commentCalls } = makeCtx({});
    const outcome = await routeInboundReply(ctx, "token", INBOUND_CONFIG, makeReply("hi"), "-100777", "hi");
    expect(outcome).toEqual({ routed: "none" });
    expect(commentCalls).toHaveLength(0);
  });

  it("swallows createComment failures without throwing to the caller", async () => {
    const stateStore: Record<string, unknown> = {
      "msg_-100777_157": { entityType: "issue", entityId: "iss-579", companyId: "co-originating" },
    };
    const { ctx } = makeCtx(stateStore);
    (ctx as { issues: { createComment: () => Promise<void> } }).issues.createComment = async () => {
      throw new Error("RPC down");
    };
    const outcome = await routeInboundReply(ctx, "token", INBOUND_CONFIG, makeReply("hi"), "-100777", "hi");
    expect(outcome).toEqual({ routed: "none" });
  });

  it("routes an escalation reply down the escalation branch, not the issue branch", async () => {
    const stateStore: Record<string, unknown> = {
      "msg_-100777_157": { entityType: "escalation", entityId: "esc-1", companyId: "co-originating" },
    };
    const { ctx, commentCalls } = makeCtx(stateStore);
    const outcome = await routeInboundReply(ctx, "token", INBOUND_CONFIG, makeReply("respond"), "-100777", "respond");
    expect(outcome).toEqual({ routed: "escalation", entityId: "esc-1" });
    expect(commentCalls).toHaveLength(0);
  });
});
