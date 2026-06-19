import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  buildDeliveryKey,
  claimDelivery,
  markDelivered,
  releaseDelivery,
  withIdempotentDelivery,
  DEFAULT_CLAIM_STALE_MS,
  type DeliveryRecord,
} from "../src/interaction-delivery.js";

// In-memory state store mirroring the SDK's scoped key/value contract.
let stateStore: Record<string, unknown>;

function mockCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        delete stateStore[key.stateKey];
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

// A controllable clock so staleness logic is deterministic.
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let ctx: PluginContext;

beforeEach(() => {
  stateStore = {};
  ctx = mockCtx();
});

describe("buildDeliveryKey", () => {
  it("is deterministic for the same parts", () => {
    expect(buildDeliveryKey("chat", 12, "issue.done:abc")).toBe(
      buildDeliveryKey("chat", 12, "issue.done:abc"),
    );
  });

  it("distinguishes different parts", () => {
    expect(buildDeliveryKey("chat-a", "", "k")).not.toBe(buildDeliveryKey("chat-b", "", "k"));
  });

  it("treats null/undefined as empty segments", () => {
    expect(buildDeliveryKey("a", null, "b")).toBe(buildDeliveryKey("a", undefined, "b"));
  });

  it("sanitizes storage-unsafe characters", () => {
    expect(buildDeliveryKey("a b/c", "x")).toBe("a_b_c|x");
  });
});

describe("claimDelivery", () => {
  it("claims an unseen slot", async () => {
    const res = await claimDelivery(ctx, "k1");
    expect(res.outcome).toBe("claimed");
    expect(res.record.status).toBe("pending");
    expect(res.record.attempts).toBe(1);
  });

  it("reports in_flight for a fresh concurrent claim", async () => {
    const c = clock();
    await claimDelivery(ctx, "k1", { now: c.now });
    c.advance(1_000); // still well within the stale window
    const res = await claimDelivery(ctx, "k1", { now: c.now });
    expect(res.outcome).toBe("in_flight");
  });

  it("reclaims a stale pending slot", async () => {
    const c = clock();
    await claimDelivery(ctx, "k1", { now: c.now });
    c.advance(DEFAULT_CLAIM_STALE_MS + 1);
    const res = await claimDelivery(ctx, "k1", { now: c.now });
    expect(res.outcome).toBe("claimed");
    expect(res.record.attempts).toBe(2); // attempt counter carried forward
  });

  it("reports already_delivered after a delivery", async () => {
    await claimDelivery(ctx, "k1");
    await markDelivered(ctx, "k1", 99);
    const res = await claimDelivery(ctx, "k1");
    expect(res.outcome).toBe("already_delivered");
    expect(res.record.messageId).toBe(99);
  });
});

describe("releaseDelivery", () => {
  it("clears a pending claim so it can be reclaimed", async () => {
    await claimDelivery(ctx, "k1");
    await releaseDelivery(ctx, "k1");
    const res = await claimDelivery(ctx, "k1");
    expect(res.outcome).toBe("claimed");
  });

  it("never clears a delivered slot", async () => {
    await claimDelivery(ctx, "k1");
    await markDelivered(ctx, "k1", 7);
    await releaseDelivery(ctx, "k1");
    const stored = stateStore["interaction_delivery_k1"] as DeliveryRecord;
    expect(stored.status).toBe("delivered");
    expect(stored.messageId).toBe(7);
  });

  it("falls back to nulling the slot when delete is unavailable", async () => {
    (ctx.state as unknown as { delete?: unknown }).delete = undefined;
    await claimDelivery(ctx, "k1");
    await releaseDelivery(ctx, "k1");
    expect(stateStore["interaction_delivery_k1"]).toBeNull();
    // A subsequent claim still succeeds.
    const res = await claimDelivery(ctx, "k1");
    expect(res.outcome).toBe("claimed");
  });
});

describe("withIdempotentDelivery", () => {
  it("sends once and returns the message id", async () => {
    const send = vi.fn(async () => 1234 as number | null);
    const result = await withIdempotentDelivery(ctx, "k1", send);
    expect(result).toBe(1234);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send a duplicate for an already-delivered slot", async () => {
    const send = vi.fn(async () => 1 as number | null);
    await withIdempotentDelivery(ctx, "k1", send);

    const send2 = vi.fn(async () => 2 as number | null);
    const result = await withIdempotentDelivery(ctx, "k1", send2);
    expect(result).toBeNull();
    expect(send2).not.toHaveBeenCalled(); // no duplicate Telegram send
  });

  it("does not send while another fresh claim is in-flight", async () => {
    const c = clock();
    await claimDelivery(ctx, "k1", { now: c.now }); // simulate an in-flight attempt
    const send = vi.fn(async () => 5 as number | null);
    const result = await withIdempotentDelivery(ctx, "k1", send, { now: c.now });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("releases the claim when the send fails (null) so a retry re-sends exactly once", async () => {
    const failing = vi.fn(async () => null as number | null);
    const first = await withIdempotentDelivery(ctx, "k1", failing);
    expect(first).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);

    // Retry: the released claim allows a fresh send.
    const ok = vi.fn(async () => 42 as number | null);
    const retry = await withIdempotentDelivery(ctx, "k1", ok);
    expect(retry).toBe(42);
    expect(ok).toHaveBeenCalledTimes(1);

    // And a third attempt is now suppressed — exactly one successful send.
    const extra = vi.fn(async () => 99 as number | null);
    expect(await withIdempotentDelivery(ctx, "k1", extra)).toBeNull();
    expect(extra).not.toHaveBeenCalled();
  });

  it("releases the claim and rethrows when the send throws", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(withIdempotentDelivery(ctx, "k1", boom)).rejects.toThrow("network down");

    // Claim was released — a retry can proceed.
    const ok = vi.fn(async () => 7 as number | null);
    expect(await withIdempotentDelivery(ctx, "k1", ok)).toBe(7);
  });

  it("guarantees at-most-once across many duplicate concurrent-style retries", async () => {
    let sends = 0;
    const send = () => {
      sends += 1;
      return Promise.resolve((1000 + sends) as number | null);
    };
    // Sequential duplicates (e.g. repeated event re-emissions) for one key.
    for (let i = 0; i < 10; i++) {
      await withIdempotentDelivery(ctx, "dup-key", send);
    }
    expect(sends).toBe(1);
  });
});
