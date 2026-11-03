/**
 * Runtime side of question cards: button presses, typed replies, sending the
 * answer to Paperclip, closing settled cards and reminding about open ones.
 * Pure card logic lives in question-cards.ts.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { answerCallbackQuery, editMessage, escapeMarkdownV2, sendMessage } from "./telegram-api.js";
import { isAlreadyResolvedInteractionError, respondInteraction } from "./interactions-api.js";
import { paperclipHttp } from "./paperclip-api.js";
import { evaluateDecisionActor } from "./decision-routing.js";
import {
  applyTextAnswer,
  buildAnswers,
  confirmationFromText,
  isComplete,
  isReminderDue,
  loadCard,
  loadOpenCards,
  missingRequired,
  parseLegacyAnswerSyntax,
  removeOpenCard,
  renderCard,
  renderClosedCard,
  saveCard,
  setAwaitingText,
  getAwaitingText,
  toggleOption,
  type CardCallback,
  type CardRef,
  type InteractionAnswer,
  type QuestionCard,
  type RenderLinks,
} from "./question-cards.js";

export type CardFlowDeps = {
  ctx: PluginContext;
  token: string;
  baseUrl: string;
  boardApiToken?: string;
  /** Lazily resolve the board token for the card's company when none was passed. */
  resolveBoardToken?: (companyId: string) => Promise<string | undefined>;
  telegramActorMappings?: Record<string, string>;
};

const NO_LINKS: RenderLinks = { issueMd: "" };

function linksOf(card: QuestionCard): RenderLinks {
  return card.links ?? { issueMd: escapeMarkdownV2(card.context.issueIdentifier) };
}

async function rerender(deps: CardFlowDeps, ref: CardRef, card: QuestionCard): Promise<void> {
  const { text, keyboard } = renderCard(card, linksOf(card));
  await editMessage(deps.ctx, deps.token, ref.chatId, ref.messageId, text, {
    parseMode: "MarkdownV2",
    inlineKeyboard: keyboard,
  });
}

/** Replace the card with its settled form (no buttons) and stop tracking it. */
export async function closeCard(
  deps: CardFlowDeps,
  ref: CardRef,
  card: QuestionCard,
  status: string,
  opts: { byWhom?: string; answers?: InteractionAnswer[]; reason?: string } = {},
): Promise<void> {
  await editMessage(
    deps.ctx,
    deps.token,
    ref.chatId,
    ref.messageId,
    renderClosedCard(card, card.links ?? NO_LINKS, status, opts),
    { parseMode: "MarkdownV2" },
  );
  await removeOpenCard(deps.ctx, ref);
  const awaiting = await getAwaitingText(deps.ctx, ref.chatId);
  if (awaiting?.messageId === ref.messageId) await setAwaitingText(deps.ctx, ref.chatId, null);
}

type SendResult = { ok: true } | { ok: false; message: string };

/** Send answers (or a confirmation decision) to Paperclip and close the card. */
async function settle(
  deps: CardFlowDeps,
  ref: CardRef,
  card: QuestionCard,
  actor: string,
  decision:
    | { action: "respond"; answers: InteractionAnswer[] }
    | { action: "accept" }
    | { action: "reject"; reason?: string },
): Promise<SendResult> {
  const boardApiToken = deps.boardApiToken ?? (await deps.resolveBoardToken?.(card.companyId));
  if (!boardApiToken) {
    return { ok: false, message: "Board access is not configured - connect it in the plugin settings." };
  }
  try {
    await respondInteraction(paperclipHttp(deps.ctx), {
      baseUrl: deps.baseUrl,
      issueId: card.issueId,
      interactionId: card.interactionId,
      action: decision.action,
      boardApiToken,
      ...(decision.action === "respond" ? { answers: decision.answers } : {}),
      ...(decision.action === "reject" && decision.reason ? { reason: decision.reason } : {}),
    });
  } catch (err) {
    if (isAlreadyResolvedInteractionError(err)) {
      // Settled elsewhere meanwhile: show the real outcome right away.
      await syncCards(deps, { issueId: card.issueId });
      return { ok: false, message: "Already settled in Paperclip." };
    }
    deps.ctx.logger.error("Failed to send Telegram answer to Paperclip", {
      issueId: card.issueId,
      interactionId: card.interactionId,
      error: String(err),
    });
    return { ok: false, message: "Could not reach Paperclip - try again in a moment." };
  }

  const status = decision.action === "respond" ? "answered" : decision.action === "accept" ? "accepted" : "rejected";
  await closeCard(deps, ref, card, status, {
    byWhom: actor,
    ...(decision.action === "respond" ? { answers: decision.answers } : {}),
    ...(decision.action === "reject" && decision.reason ? { reason: decision.reason } : {}),
  });
  deps.ctx.logger.info("Answered Paperclip question from Telegram", {
    issueId: card.issueId,
    interactionId: card.interactionId,
    action: decision.action,
  });
  return { ok: true };
}

function missingText(card: QuestionCard): string {
  const prompts = missingRequired(card).map((id) => card.questions.find((q) => q.id === id)?.prompt ?? id);
  return `Still missing: ${prompts.join("; ")}`;
}

/**
 * Handle a button press on a card. Returns false when no card is stored for
 * the pressed message, so the caller can fall back to the legacy handler.
 */
export async function handleCardCallback(
  deps: CardFlowDeps,
  query: { id: string; from: { id: number; username?: string; first_name?: string } },
  ref: CardRef,
  cb: CardCallback,
): Promise<boolean> {
  const card = await loadCard(deps.ctx, ref);
  if (!card) return false;
  const { ctx, token } = deps;
  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);

  const guard = evaluateDecisionActor({
    ownerUserId: card.ownerUserId,
    telegramActorMappings: deps.telegramActorMappings,
    fromId: query.from.id,
  });
  if (!guard.allowed) {
    ctx.logger.warn("Rejected cross-user question card press", { fromId: query.from.id, interactionId: card.interactionId });
    await answerCallbackQuery(ctx, token, query.id, "Not your decision");
    return true;
  }

  if (cb.type === "accept" || cb.type === "reject") {
    const result = await settle(deps, ref, card, actor, { action: cb.type });
    await answerCallbackQuery(ctx, token, query.id, result.ok ? (cb.type === "accept" ? "Accepted" : "Rejected") : result.message);
    return true;
  }

  if (cb.type === "submit") {
    if (!isComplete(card)) {
      await answerCallbackQuery(ctx, token, query.id, missingText(card));
      return true;
    }
    const result = await settle(deps, ref, card, actor, { action: "respond", answers: buildAnswers(card) });
    await answerCallbackQuery(ctx, token, query.id, result.ok ? "Sent" : result.message);
    return true;
  }

  const toggled = toggleOption(card, cb.q, cb.o);
  if (toggled.kind === "invalid") {
    await answerCallbackQuery(ctx, token, query.id, "That option is no longer available");
    return true;
  }
  if (toggled.kind === "updated" && toggled.submit) {
    const result = await settle(deps, ref, card, actor, { action: "respond", answers: buildAnswers(card) });
    await answerCallbackQuery(ctx, token, query.id, result.ok ? "Sent" : result.message);
    return true;
  }
  await saveCard(ctx, ref, card);
  await rerender(deps, ref, card);
  if (toggled.kind === "needs_text") {
    await setAwaitingText(ctx, ref.chatId, { messageId: ref.messageId, questionId: toggled.questionId });
    await answerCallbackQuery(ctx, token, query.id, "Type your answer as a reply to this message");
  } else {
    await answerCallbackQuery(ctx, token, query.id, "Selected");
  }
  return true;
}

/**
 * Handle typed text aimed at a card: a reply to it, or a plain message after a
 * free-text option was tapped. Returns false when there is no card to answer.
 */
export async function handleCardText(
  deps: CardFlowDeps,
  msg: { message_id: number; message_thread_id?: number; from?: { id: number; username?: string; first_name?: string } },
  ref: CardRef,
  text: string,
): Promise<boolean> {
  const card = await loadCard(deps.ctx, ref);
  if (!card) return false;
  const { ctx, token } = deps;
  const actor = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "telegram");
  const reply = (body: string) =>
    sendMessage(ctx, token, ref.chatId, body, {
      replyToMessageId: msg.message_id,
      ...(msg.message_thread_id ? { messageThreadId: msg.message_thread_id } : {}),
    }).catch(() => null);

  const guard = evaluateDecisionActor({
    ownerUserId: card.ownerUserId,
    telegramActorMappings: deps.telegramActorMappings,
    fromId: msg.from?.id,
  });
  if (!guard.allowed) {
    await reply("Not your decision.");
    return true;
  }

  if (card.kind === "request_confirmation") {
    const decision = confirmationFromText(text);
    const result = await settle(deps, ref, card, actor, decision);
    if (!result.ok) await reply(result.message);
    return true;
  }

  const legacy = parseLegacyAnswerSyntax(card, text);
  if (legacy.length > 0) {
    const result = await settle(deps, ref, card, actor, { action: "respond", answers: legacy });
    if (!result.ok) await reply(result.message);
    return true;
  }

  const awaiting = await getAwaitingText(ctx, ref.chatId);
  const preferred = awaiting?.messageId === ref.messageId ? awaiting.questionId : undefined;
  if (!applyTextAnswer(card, text, preferred)) return true;
  if (preferred) await setAwaitingText(ctx, ref.chatId, null);

  if (isComplete(card)) {
    const result = await settle(deps, ref, card, actor, { action: "respond", answers: buildAnswers(card) });
    if (!result.ok) await reply(result.message);
    return true;
  }
  await saveCard(ctx, ref, card);
  await rerender(deps, ref, card);
  await reply(`Noted. ${missingText(card)}`);
  return true;
}

/** Card waiting for a typed answer in this chat (after a free-text option tap). */
export async function awaitingCardRef(ctx: PluginContext, chatId: string): Promise<CardRef | null> {
  const awaiting = await getAwaitingText(ctx, chatId);
  return awaiting ? { chatId, messageId: awaiting.messageId } : null;
}

export type SyncOptions = {
  /** Only cards for this issue (event-driven sync); all open cards otherwise. */
  issueId?: string;
  reminder?: (card: QuestionCard) => { everyMinutes: number; maxCount: number };
  now?: number;
};

/**
 * Close cards whose interaction was settled outside Telegram (answered in the
 * board, expired, cancelled) and remind about the ones still open.
 */
export async function syncCards(deps: CardFlowDeps, opts: SyncOptions = {}): Promise<void> {
  const { ctx, token } = deps;
  const now = opts.now ?? Date.now();
  const refs = await loadOpenCards(ctx);
  const interactionsByIssue = new Map<string, Array<Record<string, unknown>> | null>();

  for (const ref of refs) {
    const card = await loadCard(ctx, ref);
    if (!card) {
      await removeOpenCard(ctx, ref);
      continue;
    }
    if (opts.issueId && card.issueId !== opts.issueId) continue;

    let interactions = interactionsByIssue.get(card.issueId);
    if (interactions === undefined) {
      try {
        interactions = (await ctx.issues.listInteractions(card.issueId, card.companyId)) as unknown as Array<
          Record<string, unknown>
        >;
      } catch (err) {
        ctx.logger.warn("Could not list interactions while syncing Telegram cards", {
          issueId: card.issueId,
          error: String(err),
        });
        interactions = null;
      }
      interactionsByIssue.set(card.issueId, interactions);
    }
    if (!interactions) continue;

    const interaction = interactions.find((i) => i.id === card.interactionId);
    const status = typeof interaction?.status === "string" ? interaction.status : "cancelled";
    if (status !== "pending") {
      const result = (interaction?.result ?? {}) as { answers?: InteractionAnswer[]; reason?: string };
      await closeCard(deps, ref, card, status, {
        ...(Array.isArray(result.answers) && result.answers.length > 0 ? { answers: result.answers } : {}),
        ...(typeof result.reason === "string" && result.reason ? { reason: result.reason } : {}),
      });
      continue;
    }

    const policy = opts.reminder?.(card);
    if (policy && isReminderDue(card, now, policy.everyMinutes, policy.maxCount)) {
      const title = card.context.issueTitle ? ` ${card.context.issueTitle}` : "";
      await sendMessage(
        ctx,
        token,
        ref.chatId,
        `⏰ Still waiting for your answer - ${card.context.issueIdentifier}${title}`,
        { replyToMessageId: ref.messageId },
      ).catch(() => null);
      card.reminders = (card.reminders ?? 0) + 1;
      card.lastReminderAt = now;
      await saveCard(ctx, ref, card);
    }
  }
}

/** Open cards delivered to this chat, oldest first. */
export async function openCardsForChat(ctx: PluginContext, chatId: string): Promise<Array<{ ref: CardRef; card: QuestionCard }>> {
  const out: Array<{ ref: CardRef; card: QuestionCard }> = [];
  for (const ref of await loadOpenCards(ctx)) {
    if (ref.chatId !== chatId) continue;
    const card = await loadCard(ctx, ref);
    if (card) out.push({ ref, card });
  }
  return out;
}
