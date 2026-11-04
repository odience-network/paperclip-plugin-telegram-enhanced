import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  escapeMarkdownV2,
  truncateAtWord,
  splitTelegramMessage,
  sendMessageWithResult,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../src/telegram-api.js";

describe("escapeMarkdownV2", () => {
  it("escapes underscores", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
  });

  it("escapes asterisks", () => {
    expect(escapeMarkdownV2("*bold*")).toBe("\\*bold\\*");
  });

  it("escapes brackets", () => {
    expect(escapeMarkdownV2("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  it("escapes backticks", () => {
    expect(escapeMarkdownV2("`code`")).toBe("\\`code\\`");
  });

  it("escapes tildes", () => {
    expect(escapeMarkdownV2("~strikethrough~")).toBe("\\~strikethrough\\~");
  });

  it("escapes hashes", () => {
    expect(escapeMarkdownV2("#heading")).toBe("\\#heading");
  });

  it("escapes plus signs", () => {
    expect(escapeMarkdownV2("a+b")).toBe("a\\+b");
  });

  it("escapes hyphens", () => {
    expect(escapeMarkdownV2("a-b")).toBe("a\\-b");
  });

  it("escapes equal signs", () => {
    expect(escapeMarkdownV2("a=b")).toBe("a\\=b");
  });

  it("escapes pipes", () => {
    expect(escapeMarkdownV2("a|b")).toBe("a\\|b");
  });

  it("escapes curly braces", () => {
    expect(escapeMarkdownV2("{a}")).toBe("\\{a\\}");
  });

  it("escapes dots", () => {
    expect(escapeMarkdownV2("a.b")).toBe("a\\.b");
  });

  it("escapes exclamation marks", () => {
    expect(escapeMarkdownV2("hello!")).toBe("hello\\!");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });

  it("escapes greater than", () => {
    expect(escapeMarkdownV2("a>b")).toBe("a\\>b");
  });

  it("handles multiple special chars in one string", () => {
    expect(escapeMarkdownV2("PROJ-42: Fix [bug] #1"))
      .toBe("PROJ\\-42: Fix \\[bug\\] \\#1");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdownV2("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("truncateAtWord", () => {
  it("returns text unchanged if shorter than max", () => {
    expect(truncateAtWord("hello", 10)).toBe("hello");
  });

  it("returns text unchanged if equal to max", () => {
    expect(truncateAtWord("hello", 5)).toBe("hello");
  });

  it("truncates at word boundary and adds ellipsis", () => {
    const result = truncateAtWord("hello world foo bar baz", 15);
    expect(result).toBe("hello world...");
  });

  it("falls back to hard cut when no good word boundary", () => {
    const result = truncateAtWord("abcdefghijklmnopqrstuvwxyz", 10);
    expect(result).toBe("abcdefghij...");
    expect(result.length).toBe(13);
  });

  it("handles single word longer than max", () => {
    const result = truncateAtWord("superlongword", 5);
    expect(result).toBe("super...");
  });

  it("handles text with trailing space at boundary", () => {
    const result = truncateAtWord("aa bb cc dd ee ff", 8);
    expect(result).toBe("aa bb cc...");
  });
});

describe("splitTelegramMessage", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(splitTelegramMessage("hello world")).toEqual(["hello world"]);
  });

  it("keeps every chunk within the limit and prefers paragraph, then line, then word boundaries", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: ` + Array(120).fill("word").join(" "),
    );
    const text = paragraphs.join("\n\n");
    const chunks = splitTelegramMessage(text, undefined, 800);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
    }
    // No boundary content is lost — rejoining (allowing for the single separator
    // consumed at each split point) reproduces the original text.
    expect(chunks.join("\n\n").replace(/\n\n\n+/g, "\n\n")).toBe(text);
  });

  it("never splits inside an HTML tag", () => {
    // Place a <b> tag straddling the 4096-char hard boundary.
    const before = "a".repeat(4095);
    const tag = "<b>";
    const after = "bold</b>" + "a".repeat(50);
    const text = before + tag + after;

    const chunks = splitTelegramMessage(text, "HTML");

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(chunks[0]).not.toMatch(/[<>]/);
    expect(chunks[1]!.startsWith("<b>")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits inside an HTML entity", () => {
    const before = "a".repeat(4095);
    const entity = "&amp;";
    const after = "rest".repeat(50);
    const text = before + entity + after;

    const chunks = splitTelegramMessage(text, "HTML");

    expect(chunks[0]).not.toContain("&");
    expect(chunks[1]!.startsWith("&amp;")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits a MarkdownV2 escape pair", () => {
    // Place a `\.` escape pair straddling the 4096-char hard boundary.
    const before = "a".repeat(4095);
    const escape = "\\.";
    const after = "b".repeat(50);
    const text = before + escape + after;

    const chunks = splitTelegramMessage(text, "MarkdownV2");

    expect(chunks.length).toBe(2);
    expect(chunks[0]!.endsWith("\\")).toBe(false);
    expect(chunks[1]!.startsWith("\\.")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits a MarkdownV2 link entity", () => {
    const link = "[a somewhat long link label](https://example.com/some/long/path)";
    const prefixLen = TELEGRAM_MAX_MESSAGE_LENGTH - Math.floor(link.length / 2);
    const text = "a".repeat(prefixLen) + link + "b".repeat(200);

    const chunks = splitTelegramMessage(text, "MarkdownV2");

    const chunkWithLink = chunks.filter((chunk) => chunk.includes(link));
    expect(chunkWithLink.length).toBe(1);
    expect(chunks.join("")).toBe(text);
  });

  it("respects a custom maxLength", () => {
    const text = "word ".repeat(200);
    const chunks = splitTelegramMessage(text, undefined, 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("closes and reopens an HTML element that straddles a chunk boundary, splitting its content on a word boundary", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
    const text = "<b>" + words.join(" ") + "</b>";

    const chunks = splitTelegramMessage(text, "HTML");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);

    // Each chunk is independently well-formed HTML: its own tags balance.
    for (const chunk of chunks) {
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(chunks[0]!.startsWith("<b>")).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("</b>")).toBe(true);

    // No word is split in half by the cut (joining with a space accounts for the
    // single separator space consumed at each split point, same as plain-text splits).
    const reconstructed = chunks
      .map((chunk) => chunk.replace(/<\/?b>/g, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ");
    expect(reconstructed).toEqual(words);
  });

  it("closes and reopens a long <pre> element rather than hard-cutting it", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `token${i}`);
    const text = "<pre>" + words.join(" ") + "</pre>";

    const chunks = splitTelegramMessage(text, "HTML");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) ?? []).length;
      const closes = (chunk.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }

    const reconstructed = chunks
      .map((chunk) => chunk.replace(/<\/?pre>/g, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ");
    expect(reconstructed).toEqual(words);
  });

  it("falls back to a word boundary inside a MarkdownV2 code block longer than one chunk, closing and reopening the fence", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `line${i}`);
    const body = words.join(" ");
    const text = "```" + body + "```";
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitTelegramMessage(text, "MarkdownV2");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);

    // Every chunk's own fences balance (an even number of ``` markers).
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    expect(chunks[0]!.startsWith("```")).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("```")).toBe(true);

    // No word is cut mid-way — unlike a raw 4096-char hard cut, which would land
    // inside one of these tokens.
    const reconstructed = chunks
      .map((chunk) => chunk.replace(/```/g, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ");
    expect(reconstructed).toEqual(words);
  });

  it("reopens a long MarkdownV2 pre block with a blank language line, so the continuation's first line isn't swallowed as a language tag", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `line${i}`);
    const text = "```" + words.join(" ") + "```";

    const chunks = splitTelegramMessage(text, "MarkdownV2");

    expect(chunks.length).toBeGreaterThan(1);
    // Telegram reads the text right after an opening ``` up to the first "\n" as
    // the (invisible) language tag. A reopened fence must put that "\n" in
    // immediately, before any real content, or the first line of the
    // continuation silently disappears from the rendered message.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith("```\n")).toBe(true);
    }
  });
});

describe("sendMessageWithResult", () => {
  function mockCtx(fetchImpl: (body: Record<string, unknown>) => { ok: boolean; result?: { message_id: number }; description?: string }) {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
      http: {
        fetch: vi.fn(async (_url: string, requestOptions: { body?: string }) => {
          const body = JSON.parse(String(requestOptions.body ?? "{}")) as Record<string, unknown>;
          calls.push(body);
          return { json: async () => fetchImpl(body) };
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metrics: { write: vi.fn() },
    } as unknown as PluginContext;
    return { ctx, calls };
  }

  it("sends short text as a single message, unchanged", async () => {
    const { ctx, calls } = mockCtx(() => ({ ok: true, result: { message_id: 1 } }));
    const result = await sendMessageWithResult(ctx, "token", "chat", "hello", { parseMode: "MarkdownV2" });

    expect(result).toEqual({ messageId: 1 });
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toBe("hello");
  });

  it("splits long text into multiple messages, attaching the inline keyboard only to the last chunk", async () => {
    let nextId = 10;
    const { ctx, calls } = mockCtx(() => ({ ok: true, result: { message_id: nextId++ } }));
    const longText = Array(2000).fill("word").join(" ");
    const keyboard = [[{ text: "Open", url: "https://example.com" }]];

    const result = await sendMessageWithResult(ctx, "token", "chat", longText, {
      inlineKeyboard: keyboard,
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(result.messageId).toBe(10); // the first chunk's message id anchors the notification
    for (const call of calls.slice(0, -1)) {
      expect(call.reply_markup).toBeUndefined();
    }
    expect(calls[calls.length - 1]!.reply_markup).toEqual({ inline_keyboard: keyboard });
  });

  it("puts replyToMessageId and messageThreadId only on the first chunk, chaining continuation chunks to the previous message", async () => {
    let nextId = 50;
    const { ctx, calls } = mockCtx(() => ({ ok: true, result: { message_id: nextId++ } }));
    const longText = Array(2000).fill("word").join(" ");

    await sendMessageWithResult(ctx, "token", "chat", longText, {
      replyToMessageId: 5,
      messageThreadId: 7,
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]!.reply_to_message_id).toBe(5);
    expect(calls[0]!.message_thread_id).toBe(7);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.message_thread_id).toBeUndefined();
      expect(calls[i]!.reply_to_message_id).toBe(49 + i); // chained to the previous chunk's message id
    }
  });

  it("surfaces Telegram's description when a chunk send fails", async () => {
    const { ctx } = mockCtx(() => ({ ok: false, description: "Bad Request: message is too long" }));
    const result = await sendMessageWithResult(ctx, "token", "chat", "hello");

    expect(result).toEqual({ messageId: null, errorDescription: "Bad Request: message is too long" });
  });

  it("reports a partial delivery (not a bare success) when a later chunk fails, keeping the first chunk's message id", async () => {
    let call = 0;
    const { ctx, calls } = mockCtx(() => {
      call++;
      if (call === 1) return { ok: true, result: { message_id: 10 } };
      return { ok: false, description: "Bad Request: message is too long" };
    });
    const longText = Array(2000).fill("word").join(" ");
    const expectedChunks = splitTelegramMessage(longText).length;
    expect(expectedChunks).toBeGreaterThan(1);

    const result = await sendMessageWithResult(ctx, "token", "chat", longText);

    expect(result.messageId).toBe(10);
    expect(result.partial).toBe(true);
    expect(result.deliveredChunks).toBe(1);
    expect(result.totalChunks).toBe(expectedChunks);
    expect(result.errorDescription).toBe("Bad Request: message is too long");
    // Stops sending once a chunk fails — it doesn't keep going and lose more chunks.
    expect(calls.length).toBe(2);
  });
});
