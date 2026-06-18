import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  shouldNotifyIssueBlocked,
  shouldNotifyBoardMention,
  parseBoardUsernames,
  matchesBoardMention,
} from "../src/notification-filters.js";

// Re-authored anti-flood filter tests for TWB-94 (port from tue-Jonas fork @03b6e99).
// Logic re-implemented against our worker; see src/notification-filters.ts.

function issueUpdatedEvent(payload: Record<string, unknown>): PluginEvent {
  return {
    companyId: "company-1",
    entityId: "issue-1",
    entityType: "issue",
    eventType: "issue.updated",
    payload,
  } as PluginEvent;
}

function commentEvent(payload: Record<string, unknown>): PluginEvent {
  return {
    companyId: "company-1",
    entityId: "comment-1",
    entityType: "comment",
    eventType: "issue.comment.created",
    payload,
  } as PluginEvent;
}

describe("shouldNotifyIssueBlocked", () => {
  it("is off when the flag is disabled, regardless of payload", () => {
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "blocked", assigneeUserId: "u1" }), false),
    ).toBe(false);
  });

  it("forwards only when status is blocked AND a human/board owns it", () => {
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "blocked", assigneeUserId: "u1" }), true),
    ).toBe(true);
  });

  it("ignores blocked issues with no human assignee (agent-only blocks)", () => {
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "blocked", assigneeUserId: null }), true),
    ).toBe(false);
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "blocked" }), true),
    ).toBe(false);
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "blocked", assigneeUserId: "   " }), true),
    ).toBe(false);
  });

  it("ignores non-blocked status changes", () => {
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "in_progress", assigneeUserId: "u1" }), true),
    ).toBe(false);
    expect(
      shouldNotifyIssueBlocked(issueUpdatedEvent({ status: "done", assigneeUserId: "u1" }), true),
    ).toBe(false);
  });
});

describe("parseBoardUsernames", () => {
  it("splits a comma/whitespace string and strips @ + lowercases", () => {
    expect(parseBoardUsernames("@CEO, Board  @ops")).toEqual(["ceo", "board", "ops"]);
  });

  it("accepts an array form", () => {
    expect(parseBoardUsernames(["@Alice", "bob"])).toEqual(["alice", "bob"]);
  });

  it("dedupes case-insensitively and drops empties", () => {
    expect(parseBoardUsernames("ceo, CEO, , @ceo")).toEqual(["ceo"]);
  });

  it("returns empty for nullish or unsupported types", () => {
    expect(parseBoardUsernames(undefined)).toEqual([]);
    expect(parseBoardUsernames(null)).toEqual([]);
    expect(parseBoardUsernames(42)).toEqual([]);
  });
});

describe("matchesBoardMention", () => {
  const handles = ["board", "ceo"];

  it("matches an @mention case-insensitively", () => {
    expect(matchesBoardMention("hey @Board can you look?", handles)).toBe(true);
    expect(matchesBoardMention("ping @CEO", handles)).toBe(true);
  });

  it("respects the trailing word boundary (no partial matches)", () => {
    expect(matchesBoardMention("welcome to the @boardroom", handles)).toBe(false);
    expect(matchesBoardMention("@ceos are here", handles)).toBe(false);
  });

  it("respects the leading boundary (no email false positives)", () => {
    expect(matchesBoardMention("contact me@board.com", handles)).toBe(false);
  });

  it("does not match a bare handle without @", () => {
    expect(matchesBoardMention("the board decided", handles)).toBe(false);
  });

  it("is false with no handles or empty text", () => {
    expect(matchesBoardMention("@board", [])).toBe(false);
    expect(matchesBoardMention("", handles)).toBe(false);
  });
});

describe("shouldNotifyBoardMention", () => {
  const handles = ["board"];

  it("is off when disabled or no handles configured", () => {
    expect(shouldNotifyBoardMention(commentEvent({ body: "@board" }), false, handles)).toBe(false);
    expect(shouldNotifyBoardMention(commentEvent({ body: "@board" }), true, [])).toBe(false);
  });

  it("forwards on a board mention in the comment body", () => {
    expect(shouldNotifyBoardMention(commentEvent({ body: "please review @board" }), true, handles)).toBe(true);
  });

  it("reads alternative body field names", () => {
    expect(shouldNotifyBoardMention(commentEvent({ comment: "@board ping" }), true, handles)).toBe(true);
    expect(shouldNotifyBoardMention(commentEvent({ text: "@board ping" }), true, handles)).toBe(true);
  });

  it("does not forward unrelated comments", () => {
    expect(shouldNotifyBoardMention(commentEvent({ body: "just a normal comment" }), true, handles)).toBe(false);
  });
});
