import type { PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Anti-flood notification filters.
 *
 * Ported from tue-Jonas/paperclip-plugin-telegram (TWB-94, commit 03b6e99) — see
 * TWB-FORK.md. The fork diverged from our v0.3.0 line (it removed the settings UI
 * and secret-ref validation we keep), so the *logic* is re-implemented here against
 * our worker rather than applying the fork's branch diff.
 *
 * These predicates gate noisy notifications behind config flags so the board chat
 * only hears signal:
 *  - issue blocked: forward `issue.updated` only when the issue is genuinely blocked
 *    AND a human/board (assigneeUserId) owns it.
 *  - board mention: forward `issue.comment.created` only when a configured board
 *    username is @-mentioned (word-boundary aware, case-insensitive).
 *
 * Note: run-started / run-finished gating (the other half of TWB-94) already exists
 * in our worker post-v0.3.0 via `notifyOnAgentRunStarted` / `notifyOnAgentRunFinished`
 * (both default off), so it is not re-implemented here.
 */

function isNonEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Forward an `issue.updated` event as a "blocked" notification only when the issue
 * transitioned to `status === "blocked"` AND it is owned by a human/board user
 * (`assigneeUserId` is non-null/non-empty). Agent-only blocked issues are noise.
 */
export function shouldNotifyIssueBlocked(event: PluginEvent, enabled: boolean): boolean {
  if (!enabled) return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload.status !== "blocked") return false;
  return isNonEmptyValue(payload.assigneeUserId);
}

/**
 * Normalize a configured board-usernames value (array or comma/whitespace-separated
 * string) into a deduped list of lowercase handles with any leading `@` stripped.
 */
export function parseBoardUsernames(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const handle = entry.trim().replace(/^@+/, "").toLowerCase();
    if (handle) seen.add(handle);
  }
  return [...seen];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary-aware, case-insensitive `@username` matcher. `@board` matches
 * "ping @board please" but not "@boardroom" (trailing boundary) nor "me@board.com"
 * (leading boundary — avoids email false positives).
 */
export function matchesBoardMention(text: string, usernames: string[]): boolean {
  if (!text || usernames.length === 0) return false;
  for (const handle of usernames) {
    const re = new RegExp(`(?<![a-z0-9_])@${escapeRegExp(handle)}(?![a-z0-9_])`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function extractCommentBody(payload: Record<string, unknown>): string {
  const candidate =
    (typeof payload.body === "string" && payload.body) ||
    (typeof payload.comment === "string" && payload.comment) ||
    (typeof payload.text === "string" && payload.text) ||
    "";
  return candidate;
}

/**
 * Forward an `issue.comment.created` event only when the comment body @-mentions one
 * of the configured board usernames.
 */
export function shouldNotifyBoardMention(
  event: PluginEvent,
  enabled: boolean,
  boardUsernames: string[],
): boolean {
  if (!enabled || boardUsernames.length === 0) return false;
  const payload = event.payload as Record<string, unknown>;
  return matchesBoardMention(extractCommentBody(payload), boardUsernames);
}
