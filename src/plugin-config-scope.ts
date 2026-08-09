// Company scoping for the host plugin-config endpoints (ODIAA-1379).
//
// Paperclip made plugin configuration company-scoped (>= 2026.707.0). The host
// routes now run every request through `requirePluginConfigCompanyId()`:
//
//   GET  /api/plugins/:pluginId/config   -> companyId from the query string
//   POST /api/plugins/:pluginId/config   -> companyId from the request body
//
// A missing or blank companyId is rejected with HTTP 400 and the message
// '"companyId" is required and must be a non-empty string'. The settings page
// used to call both routes unscoped, so every section that loaded config
// surfaced that raw host error instead of its settings.
//
// Older hosts (<= 2026.618.0) ignore the extra query param / body key, so
// sending the company scope unconditionally is backward compatible.

/**
 * Operator-facing replacement for the raw host 400. The host message names a
 * request field the operator never sees, so it reads as a plugin bug; this
 * says what to actually do instead.
 */
export const COMPANY_SCOPE_REQUIRED_MESSAGE =
  "Open this plugin's settings from inside a company. Telegram settings are stored per company, so Paperclip needs a company context to load or save them.";

/** Narrow a value to a trimmed non-empty company id, else null. */
export function normalizeCompanyId(companyId: unknown): string | null {
  if (typeof companyId !== "string") return null;
  const trimmed = companyId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the company scope or throw the operator-facing message. Callers use
 * this so a missing scope fails locally with actionable text instead of
 * round-tripping to the host for a 400.
 */
export function requireCompanyId(companyId: unknown): string {
  const normalized = normalizeCompanyId(companyId);
  if (!normalized) {
    throw new Error(COMPANY_SCOPE_REQUIRED_MESSAGE);
  }
  return normalized;
}

/**
 * Build the company-scoped config URL for `pluginId`.
 *
 * @throws when the company scope is missing or blank.
 */
export function buildPluginConfigPath(pluginId: string, companyId: unknown): string {
  const scopedCompanyId = requireCompanyId(companyId);
  return `/api/plugins/${encodeURIComponent(pluginId)}/config?companyId=${encodeURIComponent(scopedCompanyId)}`;
}

/**
 * Build the POST body for a company-scoped config save. The host reads
 * `companyId` from the body (not the query string) on writes.
 *
 * @throws when the company scope is missing or blank.
 */
export function buildPluginConfigSaveBody(
  companyId: unknown,
  configJson: Record<string, unknown>,
): { companyId: string; configJson: Record<string, unknown> } {
  return { companyId: requireCompanyId(companyId), configJson };
}
