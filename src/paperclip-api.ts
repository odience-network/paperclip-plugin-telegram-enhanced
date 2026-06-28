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

/**
 * Fail-securely detection for a Cloudflare Access login challenge that slipped
 * through as a 2xx (ODIAA-746, follow-up to ODIAA-744/ODIAA-732).
 *
 * When the board sits behind Cloudflare Access but the service-token refs
 * (`cfAccessClientIdRef` / `cfAccessClientSecretRef`) are missing or invalid, a
 * plugin→board approve/reject call carries only `Authorization: Bearer …`.
 * Access challenges it with a `302` to the SSO login page; `ctx.http.fetch`
 * follows redirects by default, so the *final* response is the Access login
 * HTML returning `200 OK`. Treating that as success makes the bot report
 * "Approved"/"Rejected" while the board action never executed.
 *
 * Board approval/reject endpoints only ever return a JSON envelope, so any of
 * these signals means the action did not execute and we must fail closed.
 * Detection (cheapest first), kept narrow so legitimate JSON / empty (204)
 * responses are never misclassified:
 *   - `cf-mitigated` header — Cloudflare's explicit challenge marker;
 *   - final response URL host ending in `.cloudflareaccess.com`;
 *   - `Content-Type: text/html` where a JSON envelope is expected.
 */
function detectCloudflareAccessChallenge(response: Response): string | null {
  if (response.headers.get("cf-mitigated")) {
    return "Cloudflare Access challenge (cf-mitigated header present); board action did not execute";
  }

  try {
    if (response.url && new URL(response.url).hostname.endsWith(".cloudflareaccess.com")) {
      return "Cloudflare Access login redirect (response served from *.cloudflareaccess.com); board action did not execute";
    }
  } catch {
    // response.url may be empty/relative in some runtimes; fall through.
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    return "non-JSON board response (Content-Type text/html — likely a Cloudflare Access login page); board action did not execute";
  }

  return null;
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

  // Fail closed: a 2xx that is actually a Cloudflare Access login challenge must
  // be treated as a failed board action, not a false "Approved"/"Rejected".
  const accessChallenge = detectCloudflareAccessChallenge(response);
  if (accessChallenge) {
    throw new PaperclipApiError(response.status, accessChallenge);
  }

  return response;
}

/**
 * Cloudflare Access service-token pair (ODIAA-742). When the Paperclip board is
 * fronted by Cloudflare Access, a bare `Authorization: Bearer <token>` is
 * rejected with an interactive login challenge, so plugin→board calls
 * (Approve/Reject buttons, `/approve`) silently fail. Sending the service
 * token's `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair lets the
 * request through Access to the origin. Both values are required — Access
 * ignores a half-configured pair — and are sourced from secret-refs, never
 * logged or echoed.
 */
export type CfAccessHeaders = {
  clientId: string;
  clientSecret: string;
};

export function buildPaperclipAuthHeaders(
  boardApiToken?: string,
  cfAccessHeaders?: CfAccessHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (boardApiToken) {
    headers.Authorization = `Bearer ${boardApiToken}`;
  }
  // Only attach the Cloudflare Access pair when BOTH halves are present; a lone
  // id or secret is never useful to Access and would just leak a partial header.
  if (cfAccessHeaders?.clientId && cfAccessHeaders.clientSecret) {
    headers["CF-Access-Client-Id"] = cfAccessHeaders.clientId;
    headers["CF-Access-Client-Secret"] = cfAccessHeaders.clientSecret;
  }
  return headers;
}
