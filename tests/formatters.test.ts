import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  formatIssueBlocked,
  formatBoardMention,
  formatResolvedDecision,
  DEFAULT_TEXT_SNIPPET_LIMIT,
} from "../src/formatters.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function mockEvent(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    entityId: "iss-123",
    entityType: "issue",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload: { identifier: "PROJ-42", title: "Test issue", ...overrides },
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Test issue");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueCreated(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("includes metadata fields when available", () => {
    const msg = formatIssueCreated(mockEvent({
      status: "open",
      priority: "high",
      assigneeName: "Alice",
      projectName: "Backend",
    }));
    expect(msg.text).toContain("open");
    expect(msg.text).toContain("high");
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Backend");
  });

  it("includes description snippet", () => {
    const msg = formatIssueCreated(mockEvent({ description: "A long description about this issue" }));
    expect(msg.text).toContain("A long description");
  });

  it("does not truncate descriptions well under the shared snippet limit", () => {
    const words = Array(50).fill("word").join(" ");
    const msg = formatIssueCreated(mockEvent({ description: words }));
    expect(msg.text).not.toContain("\\.\\.\\.");
    expect(msg.text).toContain(words);
  });

  it("truncates descriptions past the shared snippet limit and appends a Read more link", () => {
    const words = Array(DEFAULT_TEXT_SNIPPET_LIMIT).fill("word").join(" ");
    const msg = formatIssueCreated(
      mockEvent({ description: words }),
      { baseUrl: "https://app.example.com", issuePrefix: "PROJ" },
    );
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text.length).toBeLessThan(words.length);
    expect(msg.text).toContain("Read more");
    expect(msg.text).toContain("https://app.example.com/PROJ/issues/PROJ-42");
  });

  it("truncates descriptions past the limit without a Read more link when no issue URL is available", () => {
    const words = Array(DEFAULT_TEXT_SNIPPET_LIMIT).fill("word").join(" ");
    const msg = formatIssueCreated(mockEvent({ description: words }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("Read more");
  });

  it("omits metadata line when no metadata", () => {
    const msg = formatIssueCreated(mockEvent({
      status: undefined,
      priority: undefined,
      assigneeName: undefined,
      projectName: undefined,
    }));
    expect(msg.text).not.toContain("\\|");
  });
});

describe("formatIssueDone", () => {
  it("includes identifier and done text", () => {
    const msg = formatIssueDone(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("done");
  });

  it("falls back to entityId", () => {
    const msg = formatIssueDone(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("includes comment when provided", () => {
    const msg = formatIssueDone(mockEvent({ comment: "Board prep package completed for Q3" }));
    expect(msg.text).toContain("Board prep package completed for Q3");
  });

  it("does not truncate comments well under the shared snippet limit", () => {
    const longComment = Array(80).fill("word").join(" ");
    const msg = formatIssueDone(mockEvent({ comment: longComment }));
    expect(msg.text).not.toContain("\\.\\.\\.");
  });

  it("truncates comments past the shared snippet limit and appends a Read more link", () => {
    const longComment = Array(DEFAULT_TEXT_SNIPPET_LIMIT).fill("word").join(" ");
    const msg = formatIssueDone(
      mockEvent({ comment: longComment }),
      { baseUrl: "https://app.example.com", issuePrefix: "PROJ" },
    );
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).toContain("Read more");
  });

  it("omits comment section when no comment", () => {
    const msg = formatIssueDone(mockEvent());
    // Should only have the title and done line, no blockquote
    const lines = msg.text.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe("formatIssueAssigned", () => {
  it("shows the assigned user when assigning from nobody", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: null, assigneeName: null },
    }));
    expect(msg.text).toContain("Issue Assigned");
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Nuno");
    // No previous-name line
    expect(msg.text).not.toContain("→");
  });

  it("shows 'previous → new' when reassigning from another user", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: "user-other", assigneeName: "Alice" },
    }));
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Nuno");
    expect(msg.text).toContain("→");
  });

  it("shows 'Unassigned' when the new assignee is null", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: null,
      assigneeName: null,
      _previous: { assigneeUserId: "user-me", assigneeName: "Nuno" },
    }));
    expect(msg.text).toContain("Unassigned");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueAssigned(mockEvent({ assigneeName: "Nuno" }));
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueAssigned(mockEvent({ identifier: undefined, assigneeName: "Nuno" }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatApprovalCreated", () => {
  it("includes approve and reject buttons", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      approvalId: "apr-1",
      title: "Deploy to prod",
    }));
    expect(msg.options.inlineKeyboard).toBeDefined();
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons.length).toBe(2);
    expect(buttons[0].text).toBe("Approve");
    expect(buttons[0].callback_data).toBe("approve_apr-1");
    expect(buttons[1].text).toBe("Reject");
    expect(buttons[1].callback_data).toBe("reject_apr-1");
  });

  it("falls back to entityId for approvalId", () => {
    const msg = formatApprovalCreated(mockEvent({ approvalId: undefined }));
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].callback_data).toBe("approve_iss-123");
  });

  it("includes agent name when provided", () => {
    const msg = formatApprovalCreated(mockEvent({
      agentName: "Builder",
      type: "deploy",
    }));
    expect(msg.text).toContain("Builder");
  });

  it("includes linked issues", () => {
    const msg = formatApprovalCreated(mockEvent({
      linkedIssues: [
        { identifier: "ISS-1", title: "First", status: "open" },
        { identifier: "ISS-2", title: "Second", status: "done" },
      ],
    }));
    expect(msg.text).toContain("ISS\\-1");
    expect(msg.text).toContain("ISS\\-2");
    expect(msg.text).toContain("Linked Issues");
  });

  it("does not truncate descriptions well under the shared snippet limit", () => {
    const longDesc = Array(80).fill("word").join(" ");
    const msg = formatApprovalCreated(mockEvent({ description: longDesc }));
    expect(msg.text).not.toContain("\\.\\.\\.");
  });

  it("truncates descriptions past the shared snippet limit and links Read more to the first linked issue", () => {
    const longDesc = Array(DEFAULT_TEXT_SNIPPET_LIMIT).fill("word").join(" ");
    const msg = formatApprovalCreated(
      mockEvent({
        description: longDesc,
        linkedIssues: [{ identifier: "ISS-1", title: "First", status: "open" }],
      }),
      { baseUrl: "https://app.example.com", issuePrefix: "PROJ" },
    );
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).toContain("Read more");
    expect(msg.text).toContain("https://app.example.com/PROJ/issues/ISS-1");
  });

  it("truncates descriptions past the limit without a Read more link when there is no linked issue", () => {
    const longDesc = Array(DEFAULT_TEXT_SNIPPET_LIMIT).fill("word").join(" ");
    const msg = formatApprovalCreated(
      mockEvent({ description: longDesc }),
      { baseUrl: "https://app.example.com", issuePrefix: "PROJ" },
    );
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("Read more");
  });
});

describe("formatAgentError", () => {
  it("includes agent name and error", () => {
    const msg = formatAgentError(mockEvent({
      agentName: "Builder",
      error: "Connection refused",
    }));
    expect(msg.text).toContain("Builder");
    expect(msg.text).toContain("Connection refused");
  });

  it("does not truncate error messages well under the shared snippet limit", () => {
    const error = "x".repeat(600);
    const msg = formatAgentError(mockEvent({ error }));
    expect(msg.text).not.toContain("\\.\\.\\.");
    expect(msg.text).toContain("x".repeat(600));
  });

  it("truncates error messages past the shared snippet limit and links Read more to the issue", () => {
    const longError = "x".repeat(DEFAULT_TEXT_SNIPPET_LIMIT + 500);
    const msg = formatAgentError(
      mockEvent({ error: longError, issueIdentifier: "PROJ-99" }),
      { baseUrl: "https://app.example.com", issuePrefix: "PROJ" },
    );
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("x".repeat(DEFAULT_TEXT_SNIPPET_LIMIT + 1));
    expect(msg.text).toContain("Read more");
    expect(msg.text).toContain("https://app.example.com/PROJ/issues/PROJ-99");
  });

  it("falls back to entityId for agent name", () => {
    const msg = formatAgentError(mockEvent({ agentName: undefined, name: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatAgentRunStarted", () => {
  it("includes agent name", () => {
    const msg = formatAgentRunStarted(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("started");
  });

  it("disables notification", () => {
    const msg = formatAgentRunStarted(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

describe("formatAgentRunFinished", () => {
  it("includes agent name and completion text", () => {
    const msg = formatAgentRunFinished(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("completed");
  });

  it("disables notification", () => {
    const msg = formatAgentRunFinished(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

describe("formatIssueBlocked", () => {
  it("renders identifier, title and assignee", () => {
    const msg = formatIssueBlocked(
      mockEvent({ status: "blocked", assigneeName: "Alice", comment: "waiting on infra" }),
    );
    expect(msg.text).toContain("Blocked");
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("waiting on infra");
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueBlocked(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatBoardMention", () => {
  it("renders the mention with author and body", () => {
    const msg = formatBoardMention(
      mockEvent({ authorName: "Bob", body: "ping @board for sign-off" }),
    );
    expect(msg.text).toContain("Board Mention");
    expect(msg.text).toContain("Bob");
    expect(msg.text).toContain("sign\\-off");
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("derives identifier from issueIdentifier fallback", () => {
    const msg = formatBoardMention(
      mockEvent({ identifier: undefined, issueIdentifier: "PROJ-99", body: "@board" }),
    );
    expect(msg.text).toContain("PROJ\\-99");
  });
});

describe("formatResolvedDecision", () => {
  it("preserves original card context and appends an approved footer", () => {
    const original = "🔔 Approval requested\nPROJ-42 — Deploy to prod";
    const text = formatResolvedDecision(original, "approved", "amir");
    // original text is preserved (MarkdownV2-escaped) ...
    expect(text).toContain("PROJ\\-42");
    expect(text).toContain("Deploy to prod");
    // ... and the resolution footer is appended on its own paragraph
    expect(text).toContain("\n\n");
    expect(text).toContain("*Approved* by amir");
  });

  it("renders a rejected footer", () => {
    const text = formatResolvedDecision("Approval requested", "rejected", "jane");
    expect(text).toContain("*Rejected* by jane");
  });

  it("falls back to just the footer when no original text is available", () => {
    expect(formatResolvedDecision(undefined, "approved", "amir")).toBe(
      "✅ *Approved* by amir",
    );
    expect(formatResolvedDecision("   ", "rejected", "amir")).toBe(
      "❌ *Rejected* by amir",
    );
  });

  it("escapes MarkdownV2 control characters in actor and original text", () => {
    const text = formatResolvedDecision("done (mostly).", "approved", "a.b_c");
    // dot and underscore in actor, parens/dot in body must be escaped
    expect(text).toContain("a\\.b\\_c");
    expect(text).toContain("\\(mostly\\)\\.");
  });
});

