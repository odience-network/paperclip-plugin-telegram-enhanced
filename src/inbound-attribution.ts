import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveActorUserId, type TelegramActorMappings, type UserChatMappings } from "./decision-routing.js";

/**
 * Who a Telegram reply is posted *as* (ODIAA-1927).
 *
 * A comment the plugin posts under its own identity is agent-attributed: the
 * board sees it rendered as a system message, and — by design in the host — it
 * never wakes the assignee. That is why a board member's Telegram answer looked
 * like it "was not taken as a comment to process".
 *
 * `ctx.issues.createComment(..., { actorUserId })` posts the reply as the human
 * instead, which the host treats exactly like a comment typed in the web app
 * (verified active human member, then the normal wake). So the whole problem
 * reduces to: which Paperclip user is on the other end of this Telegram chat?
 *
 * We answer that in descending authority, and never guess beyond it:
 *   1. `telegramActorMappings` — the operator stated it, keyed on the immutable
 *      numeric `from.id` (same table the decision guard trusts, ODIAA-942).
 *   2. `userChatMappings` in reverse — only for a private chat whose id equals
 *      the sender's own id, which is Telegram's own guarantee that the chat has
 *      exactly one human counterpart. A group chat is never reverse-resolved:
 *      several people share one chat id, so the mapping proves nothing there.
 *   3. the company's sole active human member — unambiguous by construction.
 *      Most Paperclip installs are a one-person board that never fills in a
 *      mapping table, and without this they would keep getting system messages.
 *
 * Nothing here grants authority. Attribution decides who a *comment* is from;
 * approve/reject stays on the strict `telegramActorMappings` guard, which is
 * deny-by-default and unchanged.
 */

/** Everything about the sender that attribution is allowed to look at. */
export type InboundSender = {
  /** Immutable numeric Telegram user id (`message.from.id`). */
  fromId: number | null | undefined;
  /** Chat the reply arrived in, stringified. */
  chatId: string;
  /** Telegram chat type — only `"private"` admits reverse chat resolution. */
  chatType: string | null | undefined;
};

export type InboundAttributionSource =
  | "actor_mapping"
  | "user_chat_mapping"
  | "sole_human_member"
  | "unresolved";

export type InboundAttribution = {
  /** Paperclip user id to attribute the comment to, or null to post unattributed. */
  userId: string | null;
  source: InboundAttributionSource;
};

const UNRESOLVED: InboundAttribution = { userId: null, source: "unresolved" };

export type InboundAttributionConfig = {
  telegramActorMappings?: TelegramActorMappings;
  userChatMappings?: UserChatMappings;
};

/**
 * Reverse `userChatMappings` (userId -> chatId) for a private chat.
 *
 * Guarded three ways: the chat must be private, its id must equal the sender's
 * own numeric id (Telegram sets `chat.id === from.id` for a DM), and exactly one
 * user may map to it. Any ambiguity resolves to null rather than a guess.
 */
export function resolvePrivateChatUserId(
  userChatMappings: UserChatMappings | undefined,
  sender: InboundSender,
): string | null {
  if (!userChatMappings) return null;
  if (sender.chatType !== "private") return null;
  if (sender.fromId == null || !Number.isFinite(sender.fromId)) return null;
  if (String(sender.fromId) !== sender.chatId) return null;

  const matches = Object.entries(userChatMappings)
    .filter(([, chatId]) => typeof chatId === "string" && chatId.trim() === sender.chatId)
    .map(([userId]) => userId);
  return matches.length === 1 ? matches[0] : null;
}

/** Shape of the members `ctx.access.members.list` returns that we depend on. */
export type CompanyMemberLike = {
  principalType?: string;
  principalId?: string;
  status?: string;
};

/**
 * The company's only active human member, or null when there is none or more
 * than one. "More than one" is deliberately not a tie-break: attributing a
 * reply to the wrong colleague is worse than leaving it unattributed.
 */
export function pickSoleHumanMember(members: readonly CompanyMemberLike[]): string | null {
  const humans = members.filter(
    (member) =>
      member.principalType === "user"
      && member.status === "active"
      && typeof member.principalId === "string"
      && member.principalId.length > 0,
  );
  return humans.length === 1 ? (humans[0].principalId as string) : null;
}

/** Config-only resolution (steps 1-2). Pure, so the precedence is unit-testable. */
export function resolveConfiguredActor(
  config: InboundAttributionConfig,
  sender: InboundSender,
): InboundAttribution {
  const mapped = resolveActorUserId(config.telegramActorMappings, sender.fromId);
  if (mapped) return { userId: mapped, source: "actor_mapping" };

  const fromChat = resolvePrivateChatUserId(config.userChatMappings, sender);
  if (fromChat) return { userId: fromChat, source: "user_chat_mapping" };

  return UNRESOLVED;
}

/**
 * Full resolution: config first, then the sole-human-member lookup.
 *
 * Never throws. A denied or failing `access.members.list` (capability not
 * granted, host older than the API) degrades to an unattributed comment, which
 * is exactly the pre-ODIAA-1927 behavior — a reply must still land.
 */
export async function resolveInboundActor(
  ctx: PluginContext,
  config: InboundAttributionConfig,
  companyId: string,
  sender: InboundSender,
): Promise<InboundAttribution> {
  const configured = resolveConfiguredActor(config, sender);
  if (configured.userId) return configured;

  try {
    const members = await ctx.access.members.list({ companyId });
    const sole = pickSoleHumanMember(members as CompanyMemberLike[]);
    if (sole) return { userId: sole, source: "sole_human_member" };
  } catch (err) {
    ctx.logger.info("Could not list company members for reply attribution", {
      companyId,
      error: String(err),
    });
  }

  return UNRESOLVED;
}

/**
 * Does this error mean "the host refused the attribution" rather than "the
 * comment failed"? Both the missing-capability denial and the host's
 * active-human-member re-verification land here, and both are recoverable by
 * posting the comment unattributed instead of losing the reply.
 */
export function isAttributionRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("issue.comments.create_human_attributed")
    || /is not an active human member/i.test(message)
    || /viewer \(read-only\) access/i.test(message)
  );
}
