/**
 * User-scoped decision routing — ownership resolution + authorization guard.
 *
 * Ported & reconciled from tue-Jonas/paperclip-plugin-telegram (TWX-517/TWX-525,
 * ODIAA-938) onto our `notify()` architecture. The upstream guard resolved the
 * acting user by Telegram *username first* — this module deliberately diverges
 * per the ODIAA-942 security review and keys authorization STRICTLY on the
 * immutable numeric Telegram user id (`from.id`).
 *
 * Threat model (ODIAA-942):
 *  - Ingestion is authenticated `getUpdates` long-poll with the bot token (no
 *    public webhook), so `from.id` is not externally forgeable. `from.username`
 *    and `from.first_name` are user-mutable / reclaimable and MUST NOT drive authz.
 *  - The board API token used by `respondInteraction` is company/instance-scoped
 *    and carries no acting-user identity, so for the interaction accept/reject and
 *    native-reply paths this local guard is currently the ONLY ownership control
 *    (server-side 403 is NOT yet authoritative there — see ODIAA-938 Finding 1
 *    follow-up). It is therefore a security boundary, not a UX nicety, and is
 *    written to fail closed.
 */

/** A telegram actor mappings table: stringified numeric `from.id` -> Paperclip userId. */
export type TelegramActorMappings = Record<string, string>;
/** A user-chat mappings table: Paperclip userId -> Telegram chatId. */
export type UserChatMappings = Record<string, string>;

/**
 * Resolve the owner's Telegram chat from `userChatMappings`.
 * Returns null when the user is unknown or maps to an empty chat id.
 */
export function resolveOwnerChatId(
  userChatMappings: UserChatMappings | undefined,
  userId: string | null | undefined,
): string | null {
  if (!userId || !userChatMappings) return null;
  const chatId = userChatMappings[userId];
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

/**
 * Resolve the acting Telegram user to a Paperclip userId for the ownership guard.
 *
 * SECURITY (ODIAA-942 Findings 2 & 5): keyed STRICTLY on the immutable numeric
 * `from.id`. Usernames / first names are never consulted, because a username is
 * user-mutable and reclaimable — resolving by username would let an attacker who
 * claims a freed `@handle` inherit another user's decision ownership.
 *
 * Accepts either a bare numeric-id key (`"12345"`) or a namespaced key
 * (`"tg_id:12345"`) so admins can disambiguate from any future username entries.
 * Returns null when the actor is unmapped; callers MUST treat null as "deny".
 */
export function resolveActorUserId(
  telegramActorMappings: TelegramActorMappings | undefined,
  fromId: number | null | undefined,
): string | null {
  if (!telegramActorMappings || fromId == null || !Number.isFinite(fromId)) return null;
  const idKey = String(fromId);
  return telegramActorMappings[idKey] ?? telegramActorMappings[`tg_id:${idKey}`] ?? null;
}

/** Narrow an unknown value to a trimmed non-empty string, else null. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce an unknown value to a plain record for safe key access. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The board user a decision interaction resolved to, plus where it was found (log evidence). */
export type TargetUserResolution = { userId: string; source: string };

/**
 * Identify the board user a targeted decision card is addressed to (TWX-940 / ODIAA-937).
 *
 * Historically routing only consulted the host event's `targetUserId` (TWX-517)
 * and the fetched interaction record/payload. When NONE of those name a user —
 * older hosts that predate the field, or an interaction emitted before the issue
 * was owned — the dispatcher silently broadcast the card to the shared
 * approvals/default chat. That is how a "Decision needed / FYI for Thomas"
 * confirmation could reach the wrong chat (a confidentiality + correctness bug).
 *
 * We now resolve, in descending authority:
 *   1. the host event payload `targetUserId` (TWX-517, most authoritative);
 *   2. the fetched interaction record's `targetUserId` / `assigneeUserId`;
 *   3. the interaction record's nested payload `targetUserId` / `assigneeUserId`;
 *   4. as a last resort the issue's `assigneeUserId` (TWX-940),
 * so a decision that genuinely belongs to a specific person is routed to — or, via
 * `resolveInteractionRouting`, held for — that person instead of being broadcast.
 * `source` is returned for log evidence when diagnosing future misroutes. Returns
 * null only when no owner can be identified anywhere (legacy broadcast).
 */
export function resolveInteractionTargetUserId(input: {
  eventPayload?: Record<string, unknown> | null;
  interactionRecord?: Record<string, unknown> | null;
  interactionPayload?: Record<string, unknown> | null;
  issueAssigneeUserId?: string | null;
}): TargetUserResolution | null {
  const fromEvent = nonEmptyString(asRecord(input.eventPayload).targetUserId);
  if (fromEvent) return { userId: fromEvent, source: "event" };

  if (input.interactionRecord) {
    const record = input.interactionRecord;
    const fromInteraction = nonEmptyString(record.targetUserId) ?? nonEmptyString(record.assigneeUserId);
    if (fromInteraction) return { userId: fromInteraction, source: "interaction" };
  }

  if (input.interactionPayload) {
    const p = input.interactionPayload;
    const fromPayload = nonEmptyString(p.targetUserId) ?? nonEmptyString(p.assigneeUserId);
    if (fromPayload) return { userId: fromPayload, source: "interaction_payload" };
  }

  const fromAssignee = nonEmptyString(input.issueAssigneeUserId);
  if (fromAssignee) return { userId: fromAssignee, source: "issue_assignee" };

  return null;
}

export type InteractionRouting = {
  /** The owner userId to stamp on the stored mapping (only when owner-routed). */
  ownerUserId?: string;
  /** The owner's chat to route the decision card to (only when owner-routed). */
  targetChatId?: string;
  /**
   * True when the interaction names an owner who has NO chat mapping. The caller must
   * send a non-actionable admin setup notice and must NOT broadcast an actionable card
   * to the shared approvals chat (ODIAA-942 Finding 4 — fail closed, no leak/bypass).
   */
  needsSetupNotice: boolean;
};

/**
 * Decide how a decision card should be routed (ODIAA-938 / TWX-525):
 *  - no targetUserId            => legacy broadcast (no owner, no notice).
 *  - targetUserId + chat mapped => route to owner's chat, stamp ownerUserId.
 *  - targetUserId + no mapping  => fail closed: needsSetupNotice (do NOT broadcast).
 */
export function resolveInteractionRouting(
  targetUserId: string | null | undefined,
  userChatMappings: UserChatMappings | undefined,
): InteractionRouting {
  if (!targetUserId) return { needsSetupNotice: false };
  const targetChatId = resolveOwnerChatId(userChatMappings, targetUserId);
  if (targetChatId) return { ownerUserId: targetUserId, targetChatId, needsSetupNotice: false };
  return { needsSetupNotice: true };
}

export type DecisionActorEvaluation = {
  /** True only when the actor is permitted to act on this decision. */
  allowed: boolean;
  /** The Paperclip userId the actor's numeric id resolved to (null if unmapped). */
  actorUserId: string | null;
};

/**
 * Deny-by-default ownership decision (ODIAA-942 Finding 3).
 *
 *  - `ownerUserId` absent/null  => broadcast decision; anyone may act (`allowed: true`).
 *  - `ownerUserId` present      => the actor MUST resolve, by numeric id, to exactly
 *                                  that owner. Unmapped actor, owner-less resolution,
 *                                  and mismatched mapping ALL deny.
 *
 * Written as an allowlist so the dangerous cases (unmapped / undefined) fail closed
 * rather than open.
 */
export function evaluateDecisionActor(input: {
  ownerUserId: string | null | undefined;
  telegramActorMappings: TelegramActorMappings | undefined;
  fromId: number | null | undefined;
}): DecisionActorEvaluation {
  const actorUserId = resolveActorUserId(input.telegramActorMappings, input.fromId);
  if (input.ownerUserId == null) {
    // No owner recorded => legacy broadcast decision, not ownership-guarded.
    return { allowed: true, actorUserId };
  }
  const allowed = actorUserId != null && actorUserId === input.ownerUserId;
  return { allowed, actorUserId };
}
