import type { PluginContext } from "@paperclipai/plugin-sdk";
import { METRIC_NAMES } from "./constants.js";

const TELEGRAM_API = "https://api.telegram.org";

type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type InlineKeyboard = InlineButton[][];

export type SendMessageOptions = {
  parseMode?: "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  messageThreadId?: number;
  inlineKeyboard?: InlineKeyboard;
  disableNotification?: boolean;
};

export type SendDocumentOptions = {
  filename: string;
  caption?: string;
  parseMode?: "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;
};

type TelegramResponse = {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  parameters?: { retry_after?: number };
};

export type SendMessageResult = {
  messageId: number | null;
  /** Telegram's own failure reason (the API's `description` field), set only when the send failed. */
  errorDescription?: string;
  /** True when a split message had some chunks delivered before a later chunk failed. */
  partial?: boolean;
  /** Number of chunks successfully delivered before the failure, set only when `partial` is true. */
  deliveredChunks?: number;
  /** Total number of chunks the message was split into, set only when `partial` is true. */
  totalChunks?: number;
};

/** Telegram rejects any sendMessage/caption whose text exceeds 4096 characters. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Send one chunk of text (already within Telegram's length limit), with the
 * existing rate-limit retry and MarkdownV2-failure plain-text fallback.
 */
async function sendMessageChunk(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;
  if (options.messageThreadId) body.message_thread_id = options.messageThreadId;
  if (options.disableNotification) body.disable_notification = true;

  if (options.inlineKeyboard) {
    body.reply_markup = {
      inline_keyboard: options.inlineKeyboard,
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as TelegramResponse;

      if (!data.ok) {
        if (data.parameters?.retry_after && attempt < 2) {
          const wait = data.parameters.retry_after * 1000;
          ctx.logger.warn("Telegram rate limited, retrying", { retryAfter: data.parameters.retry_after, attempt });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (options.parseMode === "MarkdownV2") {
          ctx.logger.warn(`MarkdownV2 send failed, retrying as plain text: ${data.description ?? "unknown error"}`, {
            error: data.description,
          });
          return sendMessageChunk(ctx, token, chatId, stripMarkdown(text), {
            ...options,
            parseMode: undefined,
          });
        }
        ctx.logger.error(`Telegram sendMessage failed: ${data.description ?? "unknown error"}`, {
          error: data.description,
        });
        await ctx.metrics.write(METRIC_NAMES.failed, 1);
        return { messageId: null, errorDescription: data.description };
      }

      await ctx.metrics.write(METRIC_NAMES.sent, 1);
      return { messageId: data.result?.message_id ?? null };
    } catch (err) {
      ctx.logger.error(`Telegram API error: ${String(err)}`, { error: String(err) });
      await ctx.metrics.write(METRIC_NAMES.failed, 1);
      return { messageId: null, errorDescription: String(err) };
    }
  }
  return { messageId: null };
}

/**
 * Send `text` to a Telegram chat, splitting it across multiple messages when it
 * exceeds Telegram's 4096-character limit (see `splitTelegramMessage`) instead of
 * letting Telegram reject the whole send. The inline keyboard, if any, is attached
 * only to the last chunk; `replyToMessageId`/`messageThreadId` apply only to the
 * first chunk — later chunks reply to the previous chunk so they thread together
 * (and, in forum groups, automatically inherit its topic without repeating
 * `messageThreadId`). Returns the first chunk's message id, which callers use as
 * the stable anchor for this logical message.
 */
export async function sendMessageWithResult(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const chunks = splitTelegramMessage(text, options.parseMode);

  let firstMessageId: number | null = null;
  let previousMessageId: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;

    const chunkOptions: SendMessageOptions = {
      parseMode: options.parseMode,
      disableNotification: options.disableNotification,
    };
    if (isFirst) {
      if (options.replyToMessageId) chunkOptions.replyToMessageId = options.replyToMessageId;
      if (options.messageThreadId) chunkOptions.messageThreadId = options.messageThreadId;
    } else if (previousMessageId) {
      chunkOptions.replyToMessageId = previousMessageId;
    }
    if (isLast && options.inlineKeyboard) chunkOptions.inlineKeyboard = options.inlineKeyboard;

    const result = await sendMessageChunk(ctx, token, chatId, chunks[i]!, chunkOptions);
    if (result.messageId == null) {
      // At least one earlier chunk already landed in the chat — the caller must
      // not treat this as a clean failure, since silently retrying would re-send
      // the delivered part too. Surface it as a partial delivery instead.
      if (firstMessageId != null) {
        return {
          messageId: firstMessageId,
          errorDescription: result.errorDescription,
          partial: true,
          deliveredChunks: i,
          totalChunks: chunks.length,
        };
      }
      return { messageId: null, errorDescription: result.errorDescription };
    }
    if (isFirst) firstMessageId = result.messageId;
    previousMessageId = result.messageId;
  }

  return { messageId: firstMessageId };
}

export async function sendMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<number | null> {
  const result = await sendMessageWithResult(ctx, token, chatId, text, options);
  return result.messageId;
}

// Ported from ant013/paperclip-plugin-telegram (TEL-8, commits 0b57865/a6f5037):
// "send markdown documents with native upload fallback".
export async function sendDocumentWithResult(
  ctx: PluginContext,
  token: string,
  chatId: string,
  markdownContent: string,
  options: SendDocumentOptions,
): Promise<SendMessageResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await postTelegramDocument(ctx, token, chatId, markdownContent, options);

      if (!data.ok) {
        if (data.parameters?.retry_after && attempt < 2) {
          const wait = data.parameters.retry_after * 1000;
          ctx.logger.warn("Telegram rate limited, retrying file send", {
            retryAfter: data.parameters.retry_after,
            attempt,
          });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (options.parseMode === "MarkdownV2" && options.caption) {
          ctx.logger.warn(`MarkdownV2 file caption failed, retrying as plain text: ${data.description ?? "unknown error"}`, {
            error: data.description,
          });
          return sendDocumentWithResult(ctx, token, chatId, markdownContent, {
            ...options,
            caption: stripMarkdown(options.caption),
            parseMode: undefined,
          });
        }

        ctx.logger.error(`Telegram document send failed: ${data.description ?? "unknown error"}`, {
          error: data.description,
        });
        await ctx.metrics.write(METRIC_NAMES.failed, 1);
        return { messageId: null, errorDescription: data.description };
      }

      await ctx.metrics.write(METRIC_NAMES.sent, 1);
      return { messageId: data.result?.message_id ?? null };
    } catch (err) {
      ctx.logger.error(`Telegram document API error: ${String(err)}`, { error: String(err) });
      await ctx.metrics.write(METRIC_NAMES.failed, 1);
      return { messageId: null, errorDescription: String(err) };
    }
  }

  return { messageId: null };
}

export async function sendDocument(
  ctx: PluginContext,
  token: string,
  chatId: string,
  markdownContent: string,
  options: SendDocumentOptions,
): Promise<number | null> {
  const result = await sendDocumentWithResult(ctx, token, chatId, markdownContent, options);
  return result.messageId;
}

function buildDocumentFormData(
  chatId: string,
  markdownContent: string,
  options: SendDocumentOptions,
): FormData {
  const body = new FormData();
  body.append("chat_id", chatId);
  body.append(
    "document",
    new Blob([markdownContent], { type: "text/markdown; charset=utf-8" }),
    options.filename,
  );
  if (options.caption) body.append("caption", options.caption);
  if (options.parseMode) body.append("parse_mode", options.parseMode);
  if (options.replyToMessageId) body.append("reply_to_message_id", String(options.replyToMessageId));
  if (options.messageThreadId) body.append("message_thread_id", String(options.messageThreadId));
  if (options.disableNotification) body.append("disable_notification", "true");
  return body;
}

async function postTelegramDocument(
  ctx: PluginContext,
  token: string,
  chatId: string,
  markdownContent: string,
  options: SendDocumentOptions,
): Promise<TelegramResponse> {
  const url = `${TELEGRAM_API}/bot${token}/sendDocument`;
  const proxied = await ctx.http.fetch(url, {
    method: "POST",
    body: buildDocumentFormData(chatId, markdownContent, options),
  });
  const data = await proxied.json() as TelegramResponse;

  if (data.ok || data.description !== "Bad Request: there is no document in the request") {
    return data;
  }

  // Paperclip's HTTP bridge can lose multipart file parts while serializing FormData.
  // Retry from the worker process with native fetch so Telegram receives the Blob.
  ctx.logger.warn("Telegram document proxy upload failed, retrying with native fetch", {
    error: data.description,
  });
  const direct = await fetch(url, {
    method: "POST",
    body: buildDocumentFormData(chatId, markdownContent, options),
  });
  return await direct.json() as TelegramResponse;
}

export async function editMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  options: { parseMode?: "MarkdownV2" | "HTML"; inlineKeyboard?: InlineKeyboard } = {},
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.inlineKeyboard) {
    body.reply_markup = { inline_keyboard: options.inlineKeyboard };
  } else {
    body.reply_markup = { inline_keyboard: [] };
  }

  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch (err) {
    ctx.logger.error("Telegram editMessage failed", { error: String(err) });
    return false;
  }
}

export async function answerCallbackQuery(
  ctx: PluginContext,
  token: string,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  try {
    await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
  } catch (err) {
    ctx.logger.error("Telegram answerCallbackQuery failed", { error: String(err) });
  }
}

export type TelegramBotInfo = {
  id: number;
  username?: string;
  first_name?: string;
};

/**
 * Validate a bot token and fetch the bot identity via Telegram getMe.
 * Returns null when the token is rejected or the call fails, so callers can
 * treat a non-null result as proof the token is live.
 */
export async function getMe(
  ctx: PluginContext,
  token: string,
): Promise<TelegramBotInfo | null> {
  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
      method: "GET",
    });
    const data = (await res.json()) as { ok: boolean; result?: TelegramBotInfo };
    return data.ok && data.result ? data.result : null;
  } catch (err) {
    ctx.logger.error("Telegram getMe failed", { error: String(err) });
    return null;
  }
}

export async function setMyCommands(
  ctx: PluginContext,
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<boolean> {
  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch (err) {
    ctx.logger.error("Telegram setMyCommands failed", { error: String(err) });
    return false;
  }
}

export async function sendChatAction(
  ctx: PluginContext,
  token: string,
  chatId: string,
  action: "typing" = "typing",
): Promise<void> {
  try {
    await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // Typing indicator failures are non-critical
  }
}

/**
 * Check if a chat is a forum (has topics enabled).
 * Caches the result per chatId for the lifetime of the process.
 */
const forumCache = new Map<string, boolean>();

export async function isForum(
  ctx: PluginContext,
  token: string,
  chatId: string,
): Promise<boolean> {
  const cached = forumCache.get(chatId);
  if (cached !== undefined) return cached;

  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const data = (await res.json()) as { ok: boolean; result?: { is_forum?: boolean } };
    const result = data.ok && data.result?.is_forum === true;
    forumCache.set(chatId, result);
    return result;
  } catch {
    return false;
  }
}

/** General topic thread ID for forum groups. */
export const GENERAL_TOPIC_THREAD_ID = 1;

// MarkdownV2 requires escaping these characters
const MD_ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MD_ESCAPE_CHARS, "\\$1");
}

export function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.7 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

// --- Message splitting (ODIAA-2701) ---
//
// Telegram rejects any sendMessage whose `text` exceeds 4096 characters, so long
// notifications and `send_to_telegram` payloads must be split across several
// messages rather than truncated or failed outright. The split must never land
// inside an HTML tag/entity or a MarkdownV2 escape/entity, or Telegram's parser
// rejects the chunk that got the broken half. Formatting elements (HTML tag
// pairs; MarkdownV2 bold/italic/underline/strikethrough/spoiler/code/pre) are
// allowed to straddle a split: the element is closed at the end of one chunk
// and the same markup is reopened at the start of the next, so long elements
// (e.g. a `pre` block of log output) can still be split on a word boundary
// instead of being hard-cut mid-word.

type TelegramParseMode = "MarkdownV2" | "HTML" | undefined;

/** A half-open [start, end) character range that must never be split (escape pairs, tag/entity text, link entities, and the open/close markers of reopenable elements). */
type ProtectedSpan = [number, number];

/**
 * A formatting element whose markup may be closed at a chunk boundary and
 * reopened at the start of the next chunk. `contentStart`/`contentEnd` bound
 * the region where a split is allowed (inclusive of both ends, since cutting
 * exactly at either edge still requires closing/reopening the element).
 */
type ReopenElement = {
  start: number;
  end: number;
  openText: string;
  closeText: string;
  contentStart: number;
  contentEnd: number;
};

type SplitStructure = {
  spans: ProtectedSpan[];
  elements: ReopenElement[];
};

function findHtmlStructure(text: string): SplitStructure {
  const spans: ProtectedSpan[] = [];
  const elements: ReopenElement[] = [];
  const tagOrEntity = /<\/?[^<>]*>|&#?[a-zA-Z0-9]+;/g;
  const stack: Array<{ tagText: string; start: number; name: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagOrEntity.exec(text))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    spans.push([start, end]);

    if (raw[0] !== "<") continue; // an HTML entity, not a tag

    if (raw.startsWith("</")) {
      const name = raw.slice(2, -1).trim().toLowerCase();
      const openIdx = stack.findIndex((t) => t.name === name);
      if (openIdx !== -1) {
        const open = stack[openIdx]!;
        // Drop anything left unclosed inside this element (malformed/overlapping
        // markup) — best effort; this plugin's own formatters only ever nest cleanly.
        stack.length = openIdx;
        elements.push({
          start: open.start,
          end,
          openText: open.tagText,
          closeText: raw,
          contentStart: open.start + open.tagText.length,
          contentEnd: start,
        });
      }
      continue;
    }

    if (raw.endsWith("/>")) continue; // self-closing, e.g. <br/>

    const name = raw.slice(1, -1).trim().split(/\s/)[0]!.toLowerCase();
    stack.push({ tagText: raw, start, name });
  }

  elements.sort((a, b) => a.start - b.start);
  return { spans, elements };
}

/** Index of the next `char` at/after `from` that isn't itself an escaped character, or -1. */
function findUnescapedIndex(text: string, char: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === char) return i;
  }
  return -1;
}

// Scans for MarkdownV2 escape pairs (`\.` etc.), link entities (kept atomic —
// short, and reopening a link partway through its label has no sane meaning),
// and the reopenable bold/italic/underline/strikethrough/spoiler/code/pre
// entities. Entities are matched as simple, non-nested spans, which covers
// everything this plugin's own formatters generate.
function findMarkdownV2Structure(text: string): SplitStructure {
  const spans: ProtectedSpan[] = [];
  const elements: ReopenElement[] = [];
  const n = text.length;
  let i = 0;

  function pushElement(openStart: number, openEnd: number, closeStart: number, closeEnd: number) {
    spans.push([openStart, openEnd]);
    spans.push([closeStart, closeEnd]);
    elements.push({
      start: openStart,
      end: closeEnd,
      openText: text.slice(openStart, openEnd),
      closeText: text.slice(closeStart, closeEnd),
      contentStart: openEnd,
      contentEnd: closeStart,
    });
  }

  while (i < n) {
    const ch = text[i];
    if (ch === "\\") {
      spans.push([i, Math.min(i + 2, n)]);
      i += 2;
      continue;
    }
    if (ch === "[") {
      const closeBracket = findUnescapedIndex(text, "]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = findUnescapedIndex(text, ")", closeBracket + 2);
        if (closeParen !== -1) {
          spans.push([i, closeParen + 1]);
          i = closeParen + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const isPre = text.slice(i, i + 3) === "```";
      const markerLen = isPre ? 3 : 1;
      const marker = isPre ? "```" : "`";
      const end = text.indexOf(marker, i + markerLen);
      if (end !== -1) {
        pushElement(i, i + markerLen, end, end + markerLen);
        i = end + markerLen;
        continue;
      }
      i++;
      continue;
    }
    if ((ch === "_" && text[i + 1] === "_") || (ch === "|" && text[i + 1] === "|")) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1) {
        pushElement(i, i + 2, end, end + 2);
        i = end + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const end = findUnescapedIndex(text, ch, i + 1);
      if (end !== -1) {
        pushElement(i, i + 1, end, end + 1);
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }

  elements.sort((a, b) => a.start - b.start);
  return { spans, elements };
}

function getStructure(text: string, parseMode: TelegramParseMode): SplitStructure {
  if (parseMode === "HTML") return findHtmlStructure(text);
  if (parseMode === "MarkdownV2") return findMarkdownV2Structure(text);
  return { spans: [], elements: [] };
}

/** The span that strictly contains `index` (splitting there would divide it), if any. */
function spanContaining(index: number, spans: ProtectedSpan[]): ProtectedSpan | null {
  for (const span of spans) {
    if (index > span[0] && index < span[1]) return span;
  }
  return null;
}

/** Pulls a candidate split point back before any protected span it falls inside of. */
function retreatFromProtectedSpans(point: number, from: number, spans: ProtectedSpan[]): number {
  let candidate = point;
  for (let guard = 0; guard <= spans.length; guard++) {
    const span = spanContaining(candidate, spans);
    if (!span) return candidate;
    if (span[0] <= from) return from;
    candidate = span[0];
  }
  return candidate;
}

/** Last occurrence of `separator` in [from, hardEnd) whose split points are both safe. */
function findLastSafeSeparator(
  text: string,
  from: number,
  hardEnd: number,
  separator: string,
  spans: ProtectedSpan[],
): number {
  let idx = text.lastIndexOf(separator, hardEnd - 1);
  while (idx >= from) {
    if (!spanContaining(idx, spans) && !spanContaining(idx + separator.length, spans)) {
      return idx;
    }
    if (idx === from) break;
    idx = text.lastIndexOf(separator, idx - 1);
  }
  return -1;
}

/** Finds the best split point in [from, hardEnd), preferring paragraph, then line, then word boundaries. */
function findSplitBoundary(
  text: string,
  from: number,
  hardEnd: number,
  spans: ProtectedSpan[],
): { cutEnd: number; nextStart: number } {
  let safeHardEnd = retreatFromProtectedSpans(hardEnd, from, spans);
  if (safeHardEnd <= from) safeHardEnd = hardEnd;

  let cutEnd = findLastSafeSeparator(text, from, safeHardEnd, "\n\n", spans);
  if (cutEnd !== -1) return { cutEnd, nextStart: cutEnd + 2 };

  cutEnd = findLastSafeSeparator(text, from, safeHardEnd, "\n", spans);
  if (cutEnd !== -1) return { cutEnd, nextStart: cutEnd + 1 };

  cutEnd = findLastSafeSeparator(text, from, safeHardEnd, " ", spans);
  if (cutEnd !== -1) return { cutEnd, nextStart: cutEnd + 1 };

  if (safeHardEnd > from) return { cutEnd: safeHardEnd, nextStart: safeHardEnd };

  // The whole window is inside a protected span (e.g. a tag/entity/escape pair,
  // or a link longer than one chunk) — cut at the raw limit to guarantee progress.
  return { cutEnd: hardEnd, nextStart: hardEnd };
}

/** Reopenable elements whose content contains `pos` (inclusive of both edges), outer to inner. */
function elementsOpenAt(elements: ReopenElement[], pos: number): ReopenElement[] {
  return elements.filter((e) => pos >= e.contentStart && pos <= e.contentEnd);
}

/**
 * Split `text` into chunks that each fit within `maxLength` (Telegram's hard
 * message limit by default), breaking on paragraph ("\n\n") boundaries first,
 * then line breaks, then spaces, and only falling back to a hard cut when no
 * safe boundary exists. The split never lands inside an HTML tag/entity or a
 * MarkdownV2 escape/entity/link for the given `parseMode`. When a split falls
 * inside a reopenable formatting element (an HTML tag pair, or a MarkdownV2
 * bold/italic/underline/strikethrough/spoiler/code/pre span), the element's
 * markup is closed at the end of the chunk and reopened at the start of the
 * next one, so formatting survives the split and a single element longer than
 * one chunk can still be split at a word boundary instead of a hard cut.
 */
export function splitTelegramMessage(
  text: string,
  parseMode?: "MarkdownV2" | "HTML",
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const { spans, elements } = getStructure(text, parseMode);
  const chunks: string[] = [];
  let from = 0;
  let prefix = "";

  while (from < text.length) {
    if (text.length - from + prefix.length <= maxLength) {
      chunks.push(prefix + text.slice(from));
      break;
    }

    const budget = Math.max(1, maxLength - prefix.length);
    let hardEnd = from + budget;
    let cutEnd = from;
    let nextStart = from;
    let open: ReopenElement[] = [];

    // Re-tighten the window if the elements open at the chosen cut point need a
    // closing suffix that would push this chunk over the limit.
    for (let guard = 0; guard < 4; guard++) {
      const boundary = findSplitBoundary(text, from, hardEnd, spans);
      cutEnd = boundary.cutEnd;
      nextStart = boundary.nextStart;
      open = elementsOpenAt(elements, cutEnd);
      const suffixLength = open.reduce((sum, e) => sum + e.closeText.length, 0);

      if (prefix.length + (cutEnd - from) + suffixLength <= maxLength || cutEnd <= from + 1) break;

      const overflow = prefix.length + (cutEnd - from) + suffixLength - maxLength;
      hardEnd = Math.max(from + 1, hardEnd - overflow);
    }

    const suffix = open
      .slice()
      .reverse()
      .map((e) => e.closeText)
      .join("");

    chunks.push(prefix + text.slice(from, cutEnd) + suffix);
    prefix = open.map((e) => e.openText).join("");
    from = nextStart;
  }

  return chunks;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1")
    .replace(/[*_`~]/g, "");
}
