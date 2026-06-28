import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";

type Payload = Record<string, unknown>;

type FormattedMessage = {
  text: string;
  options: SendMessageOptions;
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function bold(s: string): string {
  return `*${esc(s)}*`;
}

function code(s: string): string {
  return `\`${esc(s)}\``;
}

export type IssueLinksOpts = { baseUrl?: string; issuePrefix?: string };

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

function issueLink(identifier: string, opts?: IssueLinksOpts): string {
  if (opts?.baseUrl && opts?.issuePrefix) {
    const url = `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}`;
    return `[${esc(identifier)}](${url})`;
  }
  return bold(identifier);
}

function issueButton(identifier: string, opts?: IssueLinksOpts): { text: string; url: string } | null {
  if (opts?.baseUrl && opts?.issuePrefix && isExternalUrl(opts.baseUrl)) {
    return { text: `Open ${identifier} ↗`, url: `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}` };
  }
  return null;
}

function agentButton(agentId: string, label: string, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl)) {
    return { text: label, url: `${publicUrl}/agents/${agentId}` };
  }
  return null;
}

function runButton(agentId: string, runId: string | null, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl) && runId) {
    return { text: "View Run ↗", url: `${publicUrl}/agents/${agentId}/runs/${runId}` };
  }
  return null;
}

/**
 * Build the text for a resolved approval/decision card.
 *
 * Ported from the tue-Jonas fork (TWX-619): rather than collapsing the card to
 * a bare status line, preserve the original card context (issue identifier,
 * title, description) and append a resolution footer so the message stays
 * legible after the buttons are removed. Falls back to just the footer when no
 * original text is available. The original text from Telegram is plain (entity
 * formatting stripped), so it is MarkdownV2-escaped before being re-sent.
 */
export function formatResolvedDecision(
  originalText: string | undefined | null,
  decision: "approved" | "rejected",
  actor: string,
): string {
  const icon = decision === "approved" ? "✅" : "❌";
  const label = decision === "approved" ? "Approved" : "Rejected";
  const footer = `${esc(icon)} ${bold(label)} by ${esc(actor)}`;
  const trimmed = (originalText ?? "").trim();
  if (!trimmed) return footer;
  return `${esc(trimmed)}\n\n${footer}`;
}

function classifyAgentError(errorMessage: string): string {
  if (/timed?\s*out|timeout/i.test(errorMessage)) return "Agent Timeout";
  if (/limit|rate.?limit|quota/i.test(errorMessage)) return "Agent Rate Limit";
  return "Agent Error";
}

function asPayload(value: unknown): Payload {
  return value && typeof value === "object" ? (value as Payload) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstNonEmptyString(source: Payload, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

type InteractionOption = {
  id: string;
  label: string;
  description?: string | null;
};

type InteractionQuestion = {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  options: InteractionOption[];
  required?: boolean;
};

function parseInteractionQuestions(value: unknown): InteractionQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: InteractionQuestion[] = [];
  for (const rawQuestion of value) {
    const q = asPayload(rawQuestion);
    const id = firstNonEmptyString(q, ["id"]) ?? "";
    const prompt = firstNonEmptyString(q, ["prompt"]) ?? "";
    if (!id || !prompt) continue;
    const selectionMode = q.selectionMode === "multi" ? "multi" : "single";
    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options: InteractionOption[] = [];
    for (const rawOption of optionsRaw) {
      const option = asPayload(rawOption);
      const optionId = firstNonEmptyString(option, ["id"]) ?? "";
      const label = firstNonEmptyString(option, ["label"]) ?? "";
      if (!optionId || !label) continue;
      options.push({
        id: optionId,
        label,
        description: stringOrNull(option.description),
      });
    }
    if (options.length === 0) continue;
    questions.push({
      id,
      prompt,
      selectionMode,
      options,
      required: q.required === true,
    });
  }
  return questions;
}

export function formatIssueCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const lines: string[] = [
    `${esc("📋")} ${bold("Issue Created")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  const meta: string[] = [];
  if (status) meta.push(`Status: ${code(status)}`);
  if (priority) meta.push(`Priority: ${code(priority)}`);
  if (assigneeName) meta.push(`Assignee: ${esc(assigneeName)}`);
  if (projectName) meta.push(`Project: ${esc(projectName)}`);
  if (meta.length > 0) lines.push(meta.join(" \\| "));

  if (p.description) {
    const desc = truncateAtWord(String(p.description), 200);
    lines.push(`\n${esc(">")} ${esc(desc)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueAssigned(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const prev = (p._previous as Payload | undefined) ?? {};
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const prevAssigneeName = prev.assigneeName ? String(prev.assigneeName) : null;

  const lines: string[] = [
    `${esc("🎯")} ${bold("Issue Assigned")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  if (assigneeName) {
    lines.push(
      prevAssigneeName
        ? `Assignee: ${esc(prevAssigneeName)} ${esc("→")} ${esc(assigneeName)}`
        : `Assignee: ${esc(assigneeName)}`,
    );
  } else {
    lines.push(esc("Unassigned"));
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueDone(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  const comment = p.comment ? String(p.comment) : null;

  const lines: string[] = [
    `${esc("✅")} ${bold("Issue Completed")}: ${issueLink(identifier, opts)}`,
    `${bold(title)} ${esc("is now done.")}`,
  ];

  if (comment) {
    const truncated = truncateAtWord(comment, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueBlocked(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const reason = p.comment ? String(p.comment) : null;

  const lines: string[] = [
    `${esc("🚫")} ${bold("Issue Blocked")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  if (assigneeName) lines.push(`Assignee: ${esc(assigneeName)}`);

  if (reason) {
    const truncated = truncateAtWord(reason, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatBoardMention(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? p.issueIdentifier ?? p.issueId ?? event.entityId);
  const title = p.title ?? p.issueTitle ? String(p.title ?? p.issueTitle) : null;
  const author = p.authorName ?? p.author ?? p.userName ?? p.agentName;
  const authorName = author ? String(author) : null;
  const body = String(p.body ?? p.comment ?? p.text ?? "");

  const lines: string[] = [
    `${esc("📣")} ${bold("Board Mention")}: ${issueLink(identifier, opts)}`,
  ];
  if (title) lines.push(bold(title));
  if (authorName) lines.push(`From: ${esc(authorName)}`);

  if (body) {
    const truncated = truncateAtWord(body, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatInteractionCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const interactionId = String(p.interactionId ?? "interaction");
  const kind = String(p.interactionKind ?? "unknown");
  const issueIdentifier = String(p.issueIdentifier ?? event.entityId);
  const issueTitle = stringOrNull(p.issueTitle);
  const interaction = asPayload(p.interaction);
  const interactionPayload = asPayload(interaction.payload);

  const lines: string[] = [
    `${esc("💬")} ${bold("Decision Interaction")}`,
    `${bold("Issue")}: ${issueLink(issueIdentifier, opts)}${issueTitle ? ` ${esc(issueTitle)}` : ""}`,
    `${bold("Kind")}: ${code(kind)}`,
  ];

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];

  if (kind === "request_confirmation") {
    const prompt = firstNonEmptyString(interactionPayload, ["prompt"]) ?? "Please confirm this action.";
    const details = firstNonEmptyString(interactionPayload, ["detailsMarkdown"]);
    const acceptLabel = firstNonEmptyString(interactionPayload, ["acceptLabel"]) ?? "Accept";
    const rejectLabel = firstNonEmptyString(interactionPayload, ["rejectLabel"]) ?? "Reject";
    lines.push(`${bold("Prompt")}: ${esc(prompt)}`);
    if (details) lines.push(`${bold("Details")}: ${esc(truncateAtWord(details, 600))}`);
    keyboard.push([
      { text: acceptLabel, callback_data: "interaction_accept" },
      { text: rejectLabel, callback_data: "interaction_reject" },
    ]);
  } else if (kind === "ask_user_questions") {
    const title = firstNonEmptyString(interactionPayload, ["title"]) ?? "Please answer the questions below.";
    const questions = parseInteractionQuestions(interactionPayload.questions);
    lines.push(`${bold("Prompt")}: ${esc(title)}`);
    for (const question of questions.slice(0, 4)) {
      lines.push(`\n${bold(question.id)}: ${esc(question.prompt)}`);
      for (const option of question.options.slice(0, 6)) {
        lines.push(`• ${esc(option.id)} = ${esc(option.label)}`);
      }
      if (question.options.length > 6) lines.push(`• ${esc(`+${String(question.options.length - 6)} more`)}`);
    }
    lines.push(`\n${esc("Reply format")}: ${code("question_id=option_id[,option_id]")}`);
  } else {
    lines.push(`${bold("Interaction ID")}: ${code(interactionId)}`);
  }

  const issueLinkButton = issueButton(issueIdentifier, opts);
  if (issueLinkButton) keyboard.push([issueLinkButton]);

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(keyboard.length > 0 ? { inlineKeyboard: keyboard } : {}),
    },
  };
}

export function formatApprovalCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "Approval Requested");
  const description = p.description ? String(p.description) : null;
  const agentName = p.agentName ? String(p.agentName) : null;

  const lines: string[] = [
    `${esc("🔔")} ${bold("Approval Requested")}`,
    bold(title),
  ];

  if (agentName) lines.push(`Agent: ${esc(agentName)} \\| Type: ${code(approvalType)}`);
  if (description) lines.push(`\n${esc(truncateAtWord(description, 300))}`);

  // Add linked issues if present
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Payload> : [];
  if (linkedIssues.length > 0) {
    lines.push(`\n${bold(`Linked Issues (${String(linkedIssues.length)})`)}`);
    for (const issue of linkedIssues.slice(0, 5)) {
      const issueId = String(issue.identifier ?? "?");
      const issueParts = [`${issueLink(issueId, opts)} ${esc(String(issue.title ?? ""))}`];
      const issueMeta: string[] = [];
      if (issue.status) issueMeta.push(String(issue.status));
      if (issue.priority) issueMeta.push(String(issue.priority));
      if (issue.assignee) issueMeta.push(`-> ${String(issue.assignee)}`);
      if (issueMeta.length > 0) issueParts.push(`\\(${esc(issueMeta.join(" | "))}\\)`);
      lines.push(issueParts.join(" "));
    }
  }

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: "Approve", callback_data: `approve_${approvalId}` },
      { text: "Reject", callback_data: `reject_${approvalId}` },
    ],
  ];

  // Add deep link to the first linked issue if available
  if (linkedIssues.length > 0) {
    const firstIssueId = String(linkedIssues[0]!.identifier ?? "");
    if (firstIssueId) {
      const btn = issueButton(firstIssueId, opts);
      if (btn) keyboard.push([btn]);
    }
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    },
  };
}

export function formatAgentError(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? p.name ?? agentId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");
  const runId = p.runId ? String(p.runId) : null;
  const companyName = p.companyName ? String(p.companyName) : null;
  const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? String(p.issueTitle) : null;

  const lines: string[] = [
    `${esc("❌")} ${bold(classifyAgentError(errorMessage))}`,
    `Agent: ${bold(agentName)}`,
  ];
  if (companyName) lines.push(`Company: ${esc(companyName)}`);
  if (issueIdentifier) {
    lines.push(
      issueTitle
        ? `Issue: ${issueLink(issueIdentifier, opts)} ${esc("—")} ${esc(issueTitle)}`
        : `Issue: ${issueLink(issueIdentifier, opts)}`,
    );
  }
  lines.push(`\n${code(truncateAtWord(errorMessage, 500))}`);

  const buttons = [
    runButton(agentId, runId, opts?.baseUrl),
    issueIdentifier ? issueButton(issueIdentifier, opts) : null,
    agentButton(agentId, "View Agent ↗", opts?.baseUrl),
  ].filter((button): button is { text: string; url: string } => Boolean(button));

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunStarted(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? agentId);
  const runId = p.runId ? String(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("▶️")} ${bold(agentName)} ${esc("started a new run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunFinished(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? agentId);
  const runId = p.runId ? String(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("⏹️")} ${bold(agentName)} ${esc("completed successfully")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}
