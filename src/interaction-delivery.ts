/**
 * Interaction-notification dedupe + idempotency guard.
 *
 * Ported (logic only) from the tue-Jonas fork — `paperclip-plugin-telegram`
 * TWX-136 (commits 8d1f0a2, 32caca9, 17ad4c6, 7bcbab0). The upstream change
 * tracked deliveries in a host DB migration (`001_interaction_deliveries.sql`).
 * We re-implement against our module layout and back the delivery-tracking
 * state with the SDK key/value store (`ctx.state`) so the plugin does not take
 * on a host migration dependency.
 *
 * Why this exists: Paperclip's core can re-emit the same plugin event for a
 * single underlying change (route logging + heartbeat reconciliation), and a
 * worker can crash or be retried mid-send. Both produce duplicate Telegram
 * notifications. This guard claims a durable delivery slot before sending,
 * skips work when a slot is already delivered (idempotency), and releases the
 * claim when a send fails so a later retry can re-attempt (no lost messages).
 *
 * The in-memory sliding-window dedupe in `worker.ts` remains as a cheap
 * fast-path for the burst case; this guard is the durable backstop that
 * survives worker restarts and guarantees at-most-once delivery per key.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Default window after which a still-`pending` claim is treated as abandoned. */
export const DEFAULT_CLAIM_STALE_MS = 60_000;

const STATE_KEY_PREFIX = "interaction_delivery_";

export type DeliveryStatus = "pending" | "delivered";

export interface DeliveryRecord {
  status: DeliveryStatus;
  /** ISO timestamp the most recent claim was taken. */
  claimedAt: string;
  /** ISO timestamp the notification was confirmed sent. */
  deliveredAt?: string;
  /** Telegram message id of the delivered notification, when known. */
  messageId?: number;
  /** Number of times a claim has been taken for this key (best-effort). */
  attempts: number;
}

export type ClaimOutcome = "claimed" | "already_delivered" | "in_flight";

export interface ClaimResult {
  outcome: ClaimOutcome;
  record: DeliveryRecord;
}

export interface DeliveryGuardOptions {
  /**
   * How long a `pending` (claimed-but-unsent) slot is honored before it is
   * considered abandoned and may be re-claimed. Guards against a worker that
   * crashed between claim and send leaving a permanently stuck slot.
   */
  staleMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a deterministic, collision-resistant state key for a delivery slot.
 *
 * Callers pass the logically-significant parts of the notification (chat,
 * topic, entity, event, and any handler-specific discriminator). The same
 * logical notification must always produce the same key; distinct
 * notifications must not collide.
 */
export function buildDeliveryKey(...parts: Array<string | number | null | undefined>): string {
  const joined = parts
    .map((p) => (p === null || p === undefined ? "" : String(p)))
    .join("|");
  // Sanitize to keep the composite state key readable and storage-safe.
  return joined.replace(/[^A-Za-z0-9._:|-]/g, "_");
}

function stateScope(key: string) {
  return { scopeKind: "instance" as const, stateKey: `${STATE_KEY_PREFIX}${key}` };
}

async function readRecord(
  ctx: PluginContext,
  key: string,
): Promise<DeliveryRecord | null> {
  const raw = (await ctx.state.get(stateScope(key))) as DeliveryRecord | null;
  if (!raw || typeof raw !== "object") return null;
  if (raw.status !== "pending" && raw.status !== "delivered") return null;
  return raw;
}

/**
 * Attempt to claim a delivery slot.
 *
 * - `already_delivered` — a prior attempt completed; skip the send (idempotent).
 * - `in_flight` — another attempt holds a fresh `pending` claim; skip to avoid a
 *   duplicate. (Stale `pending` claims are reclaimed and return `claimed`.)
 * - `claimed` — caller owns the slot and must send, then call
 *   {@link markDelivered} on success or {@link releaseDelivery} on failure.
 */
export async function claimDelivery(
  ctx: PluginContext,
  key: string,
  options: DeliveryGuardOptions = {},
): Promise<ClaimResult> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_CLAIM_STALE_MS;
  const existing = await readRecord(ctx, key);

  if (existing?.status === "delivered") {
    return { outcome: "already_delivered", record: existing };
  }

  if (existing?.status === "pending") {
    const age = now() - Date.parse(existing.claimedAt);
    if (Number.isFinite(age) && age < staleMs) {
      return { outcome: "in_flight", record: existing };
    }
    // Stale claim — reclaim it (previous attempt likely crashed mid-send).
  }

  const record: DeliveryRecord = {
    status: "pending",
    claimedAt: new Date(now()).toISOString(),
    attempts: (existing?.attempts ?? 0) + 1,
  };
  await ctx.state.set(stateScope(key), record);
  return { outcome: "claimed", record };
}

/** Mark a previously-claimed slot as delivered (idempotent terminal state). */
export async function markDelivered(
  ctx: PluginContext,
  key: string,
  messageId?: number,
  options: DeliveryGuardOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const existing = await readRecord(ctx, key);
  const record: DeliveryRecord = {
    status: "delivered",
    claimedAt: existing?.claimedAt ?? new Date(now()).toISOString(),
    deliveredAt: new Date(now()).toISOString(),
    attempts: existing?.attempts ?? 1,
    ...(messageId !== undefined ? { messageId } : {}),
  };
  await ctx.state.set(stateScope(key), record);
}

/**
 * Release an unsent claim so a future retry can re-attempt delivery.
 *
 * Only releases slots that are still `pending` — a `delivered` slot is a
 * terminal success and must never be cleared, or duplicates would resume.
 */
export async function releaseDelivery(
  ctx: PluginContext,
  key: string,
): Promise<void> {
  const existing = await readRecord(ctx, key);
  if (!existing || existing.status === "delivered") return;
  if (typeof ctx.state.delete === "function") {
    await ctx.state.delete(stateScope(key));
  } else {
    // Fallback for hosts/mocks without delete: null out the slot.
    await ctx.state.set(stateScope(key), null as unknown as DeliveryRecord);
  }
}

/**
 * Run `send` under the idempotency guard.
 *
 * Claims the slot, and on `claimed` invokes `send`. A truthy/`number` result is
 * recorded as delivered (and returned); a falsy result or a thrown error
 * releases the claim so a retry can re-send. When the slot is already delivered
 * or another attempt is in-flight, `send` is not invoked and `null` is returned.
 *
 * @returns the value from `send` on a fresh successful delivery, otherwise `null`.
 */
export async function withIdempotentDelivery<T extends number | undefined | null>(
  ctx: PluginContext,
  key: string,
  send: () => Promise<T>,
  options: DeliveryGuardOptions = {},
): Promise<T | null> {
  const claim = await claimDelivery(ctx, key, options);
  if (claim.outcome !== "claimed") return null;

  let result: T;
  try {
    result = await send();
  } catch (err) {
    await releaseDelivery(ctx, key);
    throw err;
  }

  if (result === null || result === undefined) {
    await releaseDelivery(ctx, key);
    return null;
  }

  await markDelivered(ctx, key, typeof result === "number" ? result : undefined, options);
  return result;
}
