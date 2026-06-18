import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Structured error for non-2xx Paperclip API responses. Ported from tue-Jonas
 * `PaperclipApiError` (TWX-328) onto our worker/commands layout: it preserves
 * the original throw message so existing callers/tests keep matching on
 * "Paperclip API request failed with <status>" while also exposing `status` and
 * `detail` so callers can classify conflicts (e.g. stale decision callbacks).
 */
export class PaperclipApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    const suffix = detail ? `: ${detail}` : "";
    super(`Paperclip API request failed with ${status}${suffix}`);
    this.name = "PaperclipApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Classifies "the decision is no longer actionable" conflicts so a stale inline
 * button press (TWX-328) is acknowledged gracefully instead of surfacing a raw
 * API error. Covers both shapes seen across Paperclip surfaces:
 *   - interaction conflicts: 409 "Interaction has already been resolved"
 *   - approval conflicts:    422 "Only pending or revision requested approvals
 *     can be approved/rejected" (an approval decided through another channel,
 *     expired, or already resolved in the opposite direction).
 */
export function isAlreadyResolvedConflict(error: unknown): boolean {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const status = typeof record?.status === "number" ? record.status : null;
  const detail = typeof record?.detail === "string" ? record.detail : "";
  if (status !== 409 && status !== 422) return false;
  return /already been (?:resolved|decided)|already (?:resolved|decided)|only pending(?: or revision requested)? approvals can be/i.test(
    detail,
  );
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchPaperclipApi(
  ctx: PluginContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = isLoopbackUrl(url)
    ? await fetch(url, init)
    : await ctx.http.fetch(url, init);

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    const detail = body ? body.slice(0, 300) : "";
    throw new PaperclipApiError(response.status, detail);
  }

  return response;
}

export function buildPaperclipAuthHeaders(
  boardApiToken?: string,
): Record<string, string> {
  return boardApiToken
    ? {
        Authorization: `Bearer ${boardApiToken}`,
      }
    : {};
}
