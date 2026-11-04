/**
 * Question cards: agent questions (`ask_user_questions`) and confirmations
 * (`request_confirmation`) rendered as interactive Telegram messages.
 *
 * The card is the human's whole interface to the question, so it must be
 * answerable without opening Paperclip:
 *  - options are inline buttons (single select answers on tap, multi select
 *    toggles and is sent with a Send button);
 *  - free-text answers are a plain reply to the card, no syntax to learn;
 *  - the card carries the context needed to answer (who asks, which task, why).
 *
 * This module is pure apart from the small state-store helpers at the bottom,
 * which take the plugin context explicitly. Callback data never embeds ids:
 * Telegram limits it to 64 bytes, so a button only says "option q/o" and the
 * card is found by the chat + message id of the pressed message.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { escapeMarkdownV2 } from "./telegram-api.js";

export type CardOption = { id: string; label: string; freeText?: boolean };

export type CardQuestion = {
  id: string;
  prompt: string;
  helpText?: string;
  selectionMode: "single" | "multi";
  required: boolean;
  options: CardOption[];
};

export type CardKind = "ask_user_questions" | "request_confirmation";

export type CardContext = {
  agentName?: string;
  issueIdentifier: string;
  issueTitle?: string;
  projectName?: string;
  /** Why the agent is asking: the comment the question was raised from. */
  excerpt?: string;
};

export type QuestionCard = {
  v: 1;
  kind: CardKind;
  companyId: string;
  issueId: string;
  interactionId: string;
  title?: string;
  /** request_confirmation only. */
  confirm?: { prompt: string; details?: string; acceptLabel: string; rejectLabel: string };
  questions: CardQuestion[];
  /** questionId -> chosen option ids. */
  selections: Record<string, string[]>;
  /** questionId -> typed answer (sent as `otherText`). */
  texts: Record<string, string>;
  context: CardContext;
  submitLabel?: string;
  /** Owner guard, see decision-routing.ts. */
  ownerUserId?: string;
  /** Pre-rendered issue links, so handlers outside the delivery scope can re-render. */
  links?: RenderLinks;
  chatId?: string;
  messageId?: number;
  deliveredAt?: number;
  reminders?: number;
  lastReminderAt?: number;
};

export type InteractionAnswer = { questionId: string; optionIds: string[]; otherText?: string };

type InlineButton = { text: string; callback_data?: string; url?: string };
export type RenderedCard = { text: string; keyboard: InlineButton[][] };

const EXCERPT_MAX = 500;

// --- Parsing --------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseOptions(raw: unknown): CardOption[] {
  const options: CardOption[] = [];
  for (const rawOption of Array.isArray(raw) ? raw : []) {
    const o = record(rawOption);
    const optionId = str(o.id);
    if (!optionId) continue;
    options.push({
      id: optionId,
      // A free-text option may come without a label; show something tappable.
      label: str(o.label) ?? (o.freeText === true ? "Other (type answer)" : optionId),
      ...(o.freeText === true ? { freeText: true } : {}),
    });
  }
  return options;
}

/**
 * Legacy shape: `payload.questions[]` with a `selectionMode` per question.
 * Used only when `payload.questionSet` is absent (older interactions, or a
 * caller that never sent the current schema).
 */
export function parseCardQuestions(payload: unknown): CardQuestion[] {
  const raw = record(payload).questions;
  if (!Array.isArray(raw)) return [];
  const questions: CardQuestion[] = [];
  for (const entry of raw) {
    const q = record(entry);
    const id = str(q.id);
    const prompt = str(q.prompt);
    if (!id || !prompt) continue;
    questions.push({
      id,
      prompt,
      ...(str(q.helpText) ? { helpText: str(q.helpText) } : {}),
      selectionMode: q.selectionMode === "multi" ? "multi" : "single",
      required: q.required !== false,
      options: parseOptions(q.options),
    });
  }
  return questions;
}

/**
 * Current schema (`paperclip.question_set.v1`): `payload.questionSet.questions[]`,
 * each with an `answerMode` of `single_select` / `multi_select` / `text`. A
 * `text` question has no options - it renders and answers exactly like a
 * select question with none (free-text reply fills it). Returns null when
 * `questionSet` is absent so the caller can fall back to the legacy shape.
 */
export function parseQuestionSetQuestions(payload: unknown): CardQuestion[] | null {
  const questionSet = record(payload).questionSet;
  if (!questionSet || typeof questionSet !== "object") return null;
  const raw = record(questionSet).questions;
  if (!Array.isArray(raw)) return null;
  const questions: CardQuestion[] = [];
  for (const entry of raw) {
    const q = record(entry);
    const id = str(q.id);
    const prompt = str(q.prompt);
    if (!id || !prompt) continue;
    const isText = q.answerMode === "text";
    questions.push({
      id,
      prompt,
      ...(str(q.helpText) ? { helpText: str(q.helpText) } : {}),
      selectionMode: q.answerMode === "multi_select" ? "multi" : "single",
      required: q.required !== false,
      options: isText ? [] : parseOptions(q.options),
    });
  }
  return questions;
}

/** Build a card from a Paperclip interaction record. Null for kinds we do not render. */
export function cardFromInteraction(
  interaction: Record<string, unknown>,
  context: CardContext,
): QuestionCard | null {
  const kind = interaction.kind;
  if (kind !== "ask_user_questions" && kind !== "request_confirmation") return null;
  const id = str(interaction.id);
  const issueId = str(interaction.issueId);
  const companyId = str(interaction.companyId);
  if (!id || !issueId || !companyId) return null;
  const payload = record(interaction.payload);

  const card: QuestionCard = {
    v: 1,
    kind,
    companyId,
    issueId,
    interactionId: id,
    title: str(payload.title) ?? str(interaction.title),
    questions: [],
    selections: {},
    texts: {},
    context,
  };

  if (kind === "ask_user_questions") {
    card.questions = parseQuestionSetQuestions(payload) ?? parseCardQuestions(payload);
    const submitLabel = str(payload.submitLabel);
    if (submitLabel) card.submitLabel = submitLabel;
  } else {
    card.confirm = {
      prompt: str(payload.prompt) ?? "Please confirm.",
      ...(str(payload.detailsMarkdown) ? { details: str(payload.detailsMarkdown) } : {}),
      acceptLabel: str(payload.acceptLabel) ?? "Accept",
      rejectLabel: str(payload.rejectLabel) ?? "Reject",
    };
  }
  return card;
}

// --- Answer state ----------------------------------------------------------

function isAnswered(card: QuestionCard, q: CardQuestion): boolean {
  return (card.selections[q.id]?.length ?? 0) > 0 || Boolean(card.texts[q.id]?.trim());
}

/** Ids of required questions that still have no answer. */
export function missingRequired(card: QuestionCard): string[] {
  return card.questions.filter((q) => q.required && !isAnswered(card, q)).map((q) => q.id);
}

/** A card answers itself on tap only when there is nothing else to decide. */
function isOneTap(card: QuestionCard): boolean {
  const [only] = card.questions;
  return card.questions.length === 1 && only!.selectionMode === "single";
}

export type ToggleResult =
  | { kind: "updated"; submit: boolean }
  | { kind: "needs_text"; questionId: string }
  | { kind: "invalid" };

/** Apply a button press. Mutates `card`. */
export function toggleOption(card: QuestionCard, qIndex: number, oIndex: number): ToggleResult {
  const q = card.questions[qIndex];
  const option = q?.options[oIndex];
  if (!q || !option) return { kind: "invalid" };

  if (option.freeText) {
    card.selections[q.id] = q.selectionMode === "single"
      ? [option.id]
      : Array.from(new Set([...(card.selections[q.id] ?? []), option.id]));
    return { kind: "needs_text", questionId: q.id };
  }

  const current = card.selections[q.id] ?? [];
  if (q.selectionMode === "single") {
    card.selections[q.id] = [option.id];
    delete card.texts[q.id];
    return { kind: "updated", submit: isOneTap(card) };
  }
  card.selections[q.id] = current.includes(option.id)
    ? current.filter((id) => id !== option.id)
    : [...current, option.id];
  return { kind: "updated", submit: false };
}

/**
 * Apply a typed reply. Goes to the question waiting for text (a tapped
 * free-text option), else the first unanswered question, else the last one.
 * Returns the question id that received the text, or null for an empty card.
 */
export function applyTextAnswer(card: QuestionCard, text: string, preferQuestionId?: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || card.questions.length === 0) return null;
  const target =
    card.questions.find((q) => q.id === preferQuestionId) ??
    card.questions.find((q) => !isAnswered(card, q)) ??
    card.questions[card.questions.length - 1]!;
  card.texts[target.id] = trimmed;
  const freeTextOption = target.options.find((o) => o.freeText);
  if (freeTextOption) {
    const chosen = card.selections[target.id] ?? [];
    card.selections[target.id] = target.selectionMode === "single"
      ? [freeTextOption.id]
      : Array.from(new Set([...chosen, freeTextOption.id]));
  } else if (target.selectionMode === "single") {
    // A typed answer replaces a tapped single choice instead of contradicting it.
    card.selections[target.id] = [];
  }
  return target.id;
}

/** True when every required question is answered; ready to send. */
export function isComplete(card: QuestionCard): boolean {
  return card.questions.length > 0 && missingRequired(card).length === 0;
}

export function buildAnswers(card: QuestionCard): InteractionAnswer[] {
  const answers: InteractionAnswer[] = [];
  for (const q of card.questions) {
    if (!isAnswered(card, q)) continue;
    const text = card.texts[q.id]?.trim();
    answers.push({
      questionId: q.id,
      optionIds: card.selections[q.id] ?? [],
      ...(text ? { otherText: text } : {}),
    });
  }
  return answers;
}

/**
 * Legacy reply syntax from the original plugin (`question_id=option_id[,option_id]`
 * per line). Kept so muscle memory and existing docs keep working.
 */
export function parseLegacyAnswerSyntax(card: QuestionCard, text: string): InteractionAnswer[] {
  const answers: InteractionAnswer[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split("=");
    if (parts.length !== 2) continue;
    const q = card.questions.find((candidate) => candidate.id === parts[0]!.trim());
    if (!q) continue;
    const valid = new Set(q.options.map((o) => o.id));
    const optionIds = parts[1]!.split(",").map((s) => s.trim()).filter((s) => valid.has(s));
    if (optionIds.length === 0) continue;
    answers.push({
      questionId: q.id,
      optionIds: q.selectionMode === "single" ? [optionIds[0]!] : Array.from(new Set(optionIds)),
    });
  }
  return answers;
}

const AFFIRMATIVE = new Set([
  "accept", "approve", "approved", "yes", "y", "ok", "okay", "sure", "confirm", "go",
  "tak", "ok.", "zgoda", "potwierdzam", "akceptuje", "akceptuję", "👍", "✅",
]);

/** A typed reply to a confirmation card: short yes-words accept, anything else rejects with the text as reason. */
export function confirmationFromText(text: string): { action: "accept" } | { action: "reject"; reason: string } {
  const normalized = text.trim().toLowerCase();
  return AFFIRMATIVE.has(normalized) ? { action: "accept" } : { action: "reject", reason: text.trim() };
}

// --- Callback data ----------------------------------------------------------

export const CALLBACK_PREFIX = "qc";

export type CardCallback =
  | { type: "option"; q: number; o: number }
  | { type: "submit" }
  | { type: "accept" }
  | { type: "reject" };

export function optionCallbackData(q: number, o: number): string {
  return `${CALLBACK_PREFIX}:o:${q}:${o}`;
}

export function parseCardCallback(data: string): CardCallback | null {
  if (data === "interaction_accept") return { type: "accept" };
  if (data === "interaction_reject") return { type: "reject" };
  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PREFIX) return null;
  if (parts[1] === "s") return { type: "submit" };
  if (parts[1] === "a") return { type: "accept" };
  if (parts[1] === "r") return { type: "reject" };
  if (parts[1] === "o" && parts.length === 4) {
    const q = Number(parts[2]);
    const o = Number(parts[3]);
    if (Number.isInteger(q) && Number.isInteger(o) && q >= 0 && o >= 0) return { type: "option", q, o };
  }
  return null;
}

// --- Rendering --------------------------------------------------------------

const esc = escapeMarkdownV2;
const bold = (s: string) => `*${esc(s)}*`;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+\n/g, "\n").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}

const DETAILS_MAX = 1500;
const BUTTON_LABEL_MAX = 32;

function removeLast(text: string, token: string): string {
  const i = text.lastIndexOf(token);
  return i < 0 ? text : text.slice(0, i) + text.slice(i + token.length);
}

/** Inline markup reduced to its text: links keep their label, code and bold lose their markers. */
function plainInline(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1");
}

/**
 * Agent-written markdown as Telegram MarkdownV2. Bold, inline code, headings and list bullets survive; links keep
 * only their label, because board-relative URLs open nothing on a phone. Everything else is escaped, so stray
 * markup shows as text instead of breaking the message.
 */
export function agentMarkdownToV2(text: string): string {
  let src = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+(.+)$/, "**$1**").replace(/^(\s*)[-*+]\s+/, "$1• "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  // Truncation can end inside a pair; drop the unmatched opener instead of showing it literally.
  if ((src.match(/\*\*/g) ?? []).length % 2) src = removeLast(src, "**");
  if ((src.match(/`/g) ?? []).length % 2) src = removeLast(src, "`");

  const out: string[] = [];
  const re = /\*\*(.+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push(esc(src.slice(last, m.index)));
    if (m[1] !== undefined) out.push(`*${esc(plainInline(m[1]))}*`);
    else if (m[2] !== undefined) out.push("`" + m[2].replace(/[`\\]/g, "\\$&") + "`");
    else out.push(esc(m[3]!));
    last = re.lastIndex;
  }
  out.push(esc(src.slice(last)));
  return out.join("");
}

/** MarkdownV2 text as an expandable block quote: the first line visible, the rest behind a tap. */
export function expandableQuote(v2: string): string {
  return `${v2.split("\n").map((line, i) => `${i === 0 ? "**>" : ">"}${line}`).join("\n")}||`;
}

function buttonLabel(label: string): string {
  const flat = plainInline(label).trim();
  return flat.length <= BUTTON_LABEL_MAX ? flat : `${flat.slice(0, BUTTON_LABEL_MAX - 1)}…`;
}

export type RenderLinks = {
  /** MarkdownV2-ready issue reference (link or code span). */
  issueMd: string;
  issueButton?: { text: string; url: string } | null;
};

function header(card: QuestionCard, links: RenderLinks, opts: { compact?: boolean } = {}): string[] {
  const c = card.context;
  const who = c.agentName ? `${c.agentName} asks` : "An agent asks";
  const icon = card.kind === "request_confirmation" ? "🟡" : "❓";
  const lines = [`${esc(icon)} ${bold(who)}`];
  const where = [links.issueMd];
  if (c.issueTitle) where.push(esc(c.issueTitle));
  lines.push(where.join(" "));
  if (c.projectName) lines.push(`${esc("📁")} ${esc(c.projectName)}`);
  // A confirmation carries its own summary in `details`; the agent's comment would only repeat it.
  const showExcerpt = !opts.compact && c.excerpt && !(card.kind === "request_confirmation" && card.confirm?.details);
  if (showExcerpt) {
    lines.push("", expandableQuote(`${esc("💬")} ${agentMarkdownToV2(truncate(c.excerpt!, EXCERPT_MAX))}`));
  }
  return lines;
}

/** Telegram rejects a message text over this many characters. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Build the card body and keyboard. Every question and option always gets a
 * button - this never drops one. `compact` drops narrative text (the agent's
 * excerpt, per-question help text, confirmation details) to make room; it
 * never touches the answerable surface.
 */
function renderCardPass(card: QuestionCard, links: RenderLinks, compact: boolean): RenderedCard {
  const lines = header(card, links, { compact });
  const keyboard: InlineButton[][] = [];

  if (card.kind === "request_confirmation" && card.confirm) {
    lines.push("", bold(plainInline(card.confirm.prompt)));
    if (card.confirm.details && !compact) {
      lines.push(expandableQuote(agentMarkdownToV2(truncate(card.confirm.details, DETAILS_MAX))));
    }
    lines.push("", `_${esc("Tap a button, or reply with a reason to reject.")}_`);
    keyboard.push([
      { text: `✅ ${buttonLabel(card.confirm.acceptLabel)}`, callback_data: `${CALLBACK_PREFIX}:a` },
      { text: `❌ ${buttonLabel(card.confirm.rejectLabel)}`, callback_data: `${CALLBACK_PREFIX}:r` },
    ]);
  } else {
    if (card.title) lines.push("", bold(plainInline(card.title)));
    const numbered = card.questions.length > 1;
    card.questions.forEach((q, qi) => {
      const label = numbered ? `${qi + 1}. ${q.prompt}` : q.prompt;
      const mode = q.selectionMode === "multi" ? " (choose any)" : "";
      lines.push("", `${bold(plainInline(label))}${esc(mode)}`);
      if (q.helpText && !compact) lines.push(agentMarkdownToV2(truncate(q.helpText, 300)));
      const typed = card.texts[q.id];
      if (typed) lines.push(`${esc("✍️")} ${esc(truncate(typed, compact ? 80 : 300))}`);
      if (q.options.length === 0) lines.push(`_${esc("Reply to this message with your answer.")}_`);

      // Every option becomes a button - never capped, so a long list is never
      // silently dropped. Telegram's own keyboard/text limits are handled by
      // the overflow fallback in renderCard, not by hiding options here.
      const chosen = new Set(card.selections[q.id] ?? []);
      q.options.forEach((o, oi) => {
        const mark = chosen.has(o.id) ? "✅ " : o.freeText ? "✍️ " : "";
        const prefix = numbered ? `${qi + 1}: ` : "";
        keyboard.push([{ text: `${mark}${prefix}${buttonLabel(o.label)}`, callback_data: optionCallbackData(qi, oi) }]);
      });
    });
    if (!isOneTap(card)) {
      keyboard.push([{ text: `📨 ${card.submitLabel ?? "Send"}`, callback_data: `${CALLBACK_PREFIX}:s` }]);
    }
    lines.push("", `_${esc("Tap an option or reply to this message with your own answer.")}_`);
  }

  if (links.issueButton) keyboard.push([links.issueButton]);
  return { text: lines.join("\n"), keyboard };
}

/**
 * Render the card body and keyboard for its current answer state.
 *
 * A card with many questions or a long agent comment can exceed Telegram's
 * 4096-character message limit. Rather than silently truncating a question
 * or option off the end, this drops narrative text first (compact pass),
 * and if that is still not enough, hard-truncates the text while keeping
 * every button and adding an explicit "open in Paperclip" link so nothing
 * answerable is ever lost - only the prose around it is shortened.
 */
export function renderCard(card: QuestionCard, links: RenderLinks): RenderedCard {
  const full = renderCardPass(card, links, false);
  if (full.text.length <= TELEGRAM_TEXT_LIMIT) return full;

  const compact = renderCardPass(card, links, true);
  if (compact.text.length <= TELEGRAM_TEXT_LIMIT) return compact;

  // The issue link (when configured) is already in `compact.keyboard` via
  // `header`/the trailing `links.issueButton` row; every question/option
  // button is intact too - only the narrative text above is shortened.
  const overflowNote = `\n\n_${esc(`Open in Paperclip to see all ${card.questions.length} questions.`)}_`;
  const text = `${truncate(compact.text, TELEGRAM_TEXT_LIMIT - overflowNote.length)}${overflowNote}`;
  return { text, keyboard: compact.keyboard };
}

/** Plain summary of what was answered, for the closed card. */
export function describeAnswers(card: QuestionCard, answers: InteractionAnswer[]): string[] {
  return answers.map((a) => {
    const q = card.questions.find((candidate) => candidate.id === a.questionId);
    const labels = a.optionIds
      .map((id) => q?.options.find((o) => o.id === id))
      .filter((o): o is CardOption => Boolean(o) && !o!.freeText)
      .map((o) => o.label);
    if (a.otherText) labels.push(`"${a.otherText}"`);
    return `${q?.prompt ?? a.questionId}: ${labels.join(", ") || "-"}`;
  });
}

const STATUS_LINES: Record<string, string> = {
  answered: "✅ Answered",
  accepted: "✅ Accepted",
  rejected: "❌ Rejected",
  expired: "⌛ Expired - the agent moved on",
  cancelled: "🚫 Cancelled",
  failed: "⚠️ Failed",
};

/**
 * Text for a card that is no longer actionable. `byWhom` is shown when the
 * answer came from this chat; otherwise the card says it was settled in Paperclip.
 */
export function renderClosedCard(
  card: QuestionCard,
  links: RenderLinks,
  status: string,
  opts: { byWhom?: string; answers?: InteractionAnswer[]; reason?: string } = {},
): string {
  const lines = header(card, links);
  if (card.kind === "request_confirmation" && card.confirm) lines.push("", bold(card.confirm.prompt));
  else if (card.title) lines.push("", bold(card.title));
  const summary = opts.answers ? describeAnswers(card, opts.answers) : [];
  for (const line of summary) lines.push(esc(`• ${line}`));
  if (opts.reason) lines.push(esc(`• ${truncate(opts.reason, 300)}`));
  const statusLine = STATUS_LINES[status] ?? `Status: ${status}`;
  const by = opts.byWhom ? ` by ${opts.byWhom}` : " in Paperclip";
  lines.push("", bold(`${statusLine}${status === "expired" || status === "cancelled" ? "" : by}`));
  return lines.join("\n");
}

// --- Reminders --------------------------------------------------------------

export function isReminderDue(
  card: QuestionCard,
  now: number,
  everyMinutes: number,
  maxCount: number,
): boolean {
  if (everyMinutes <= 0 || maxCount <= 0) return false;
  if ((card.reminders ?? 0) >= maxCount) return false;
  const since = card.lastReminderAt ?? card.deliveredAt;
  if (since === undefined) return false;
  return now - since >= everyMinutes * 60_000;
}

// --- State store ------------------------------------------------------------
// The SDK state API is get/set by key with no listing, so open cards are kept
// in one bounded index next to the per-card records.

const INDEX_KEY = "question_cards_open_v1";
const MAX_OPEN_CARDS = 200;

export type CardRef = { chatId: string; messageId: number };

function cardKey(ref: CardRef): string {
  return `qcard_${ref.chatId}_${ref.messageId}`;
}

function instanceScope(stateKey: string) {
  return { scopeKind: "instance" as const, stateKey };
}

export async function loadCard(ctx: PluginContext, ref: CardRef): Promise<QuestionCard | null> {
  const value = await ctx.state.get(instanceScope(cardKey(ref)));
  const card = value as QuestionCard | null;
  return card && card.v === 1 && card.interactionId ? card : null;
}

export async function saveCard(ctx: PluginContext, ref: CardRef, card: QuestionCard): Promise<void> {
  await ctx.state.set(instanceScope(cardKey(ref)), card);
}

export async function loadOpenCards(ctx: PluginContext): Promise<CardRef[]> {
  const value = await ctx.state.get(instanceScope(INDEX_KEY));
  return Array.isArray(value) ? (value as CardRef[]) : [];
}

export async function addOpenCard(ctx: PluginContext, ref: CardRef): Promise<void> {
  const refs = (await loadOpenCards(ctx)).filter(
    (r) => !(r.chatId === ref.chatId && r.messageId === ref.messageId),
  );
  refs.push(ref);
  await ctx.state.set(instanceScope(INDEX_KEY), refs.slice(-MAX_OPEN_CARDS));
}

export async function removeOpenCard(ctx: PluginContext, ref: CardRef): Promise<void> {
  const refs = await loadOpenCards(ctx);
  const next = refs.filter((r) => !(r.chatId === ref.chatId && r.messageId === ref.messageId));
  if (next.length !== refs.length) await ctx.state.set(instanceScope(INDEX_KEY), next);
}

/** The card in this chat waiting for a typed answer after a free-text option tap. */
function awaitingKey(chatId: string): string {
  return `qcard_awaiting_text_${chatId}`;
}

export async function setAwaitingText(
  ctx: PluginContext,
  chatId: string,
  value: { messageId: number; questionId: string } | null,
): Promise<void> {
  await ctx.state.set(instanceScope(awaitingKey(chatId)), value ?? { messageId: 0, questionId: "" });
}

export async function getAwaitingText(
  ctx: PluginContext,
  chatId: string,
): Promise<{ messageId: number; questionId: string } | null> {
  const value = (await ctx.state.get(instanceScope(awaitingKey(chatId)))) as
    | { messageId: number; questionId: string }
    | null;
  return value && value.messageId > 0 && value.questionId ? value : null;
}
