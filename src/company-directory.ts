import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Company directory — a proactive-safe company lookup for the polling loop.
 *
 * Bot commands run from the long-poll loop, which is a *proactive* worker→host
 * context: no host-issued invocation id is echoed on the RPC. The host resolves
 * such a call against the plugin's configured companies, but only when the call
 * names exactly one company (`params.companyId`). A wildcard call is refused on
 * purpose — `companies.list` is documented as never proactively granted — and
 * it fails with "not allowed to perform companies.list: the worker referenced a
 * missing, expired, or unknown invocation scope" whenever any other invocation
 * happens to be live (ODIAA-1927).
 *
 * `/connect` used to be built entirely on that wildcard, so it could never link
 * a chat from the poll loop. The directory fixes it: every company we see from
 * an invocation-scoped context (event handlers, jobs) is cached in instance
 * state, and lookups fall back to that cache plus single-company
 * `ctx.companies.get()` — both of which the proactive gate does admit.
 */

export const COMPANY_DIRECTORY_STATE_KEY = "companies_directory_v1";

/** Cap the cache so a many-tenant instance cannot grow state without bound. */
const MAX_DIRECTORY_ENTRIES = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompanyDirectoryEntry {
  id: string;
  name?: string;
}

export interface CompanyLookup {
  companies: CompanyDirectoryEntry[];
  /** `live` when `companies.list` answered, `cache` when we fell back. */
  source: "live" | "cache";
  /** Why the live listing was unusable, when it was. */
  error?: string;
}

function normalize(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toEntries(value: unknown): CompanyDirectoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CompanyDirectoryEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = normalize(record.id);
    if (!id) continue;
    const name = normalize(record.name);
    entries.push(name ? { id, name } : { id });
  }
  return entries;
}

/** Read the cached directory. Never throws — an unreadable cache is an empty one. */
export async function readCompanyDirectory(ctx: PluginContext): Promise<CompanyDirectoryEntry[]> {
  try {
    const stored = await ctx.state.get({
      scopeKind: "instance",
      stateKey: COMPANY_DIRECTORY_STATE_KEY,
    });
    return toEntries(stored);
  } catch {
    return [];
  }
}

/**
 * Merge companies into the cached directory, newest name wins. Best effort:
 * this runs on the notification path and must never break a delivery.
 */
export async function rememberCompanies(
  ctx: PluginContext,
  entries: CompanyDirectoryEntry[],
): Promise<CompanyDirectoryEntry[]> {
  const incoming = toEntries(entries);
  if (incoming.length === 0) return readCompanyDirectory(ctx);

  const existing = await readCompanyDirectory(ctx);
  const byId = new Map<string, CompanyDirectoryEntry>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) {
    const previous = byId.get(entry.id);
    byId.set(entry.id, { id: entry.id, ...(entry.name ?? previous?.name ? { name: entry.name ?? previous?.name } : {}) });
  }

  const merged = Array.from(byId.values()).slice(0, MAX_DIRECTORY_ENTRIES);
  const unchanged =
    merged.length === existing.length &&
    merged.every((entry, index) => entry.id === existing[index]?.id && entry.name === existing[index]?.name);
  if (unchanged) return merged;

  try {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: COMPANY_DIRECTORY_STATE_KEY },
      merged,
    );
  } catch {
    /* best effort — the caller still gets the merged view for this call */
  }
  return merged;
}

/**
 * List companies without depending on `companies.list` succeeding.
 *
 * Prefers the live listing (correct and complete when we are inside an
 * invocation scope) and refreshes the cache from it; falls back to the cache
 * when the host refuses the wildcard call.
 */
export async function listCompaniesResilient(ctx: PluginContext): Promise<CompanyLookup> {
  try {
    const live = await ctx.companies.list();
    const entries = toEntries(
      live.map((company) => ({ id: company.id, name: (company as { name?: string }).name })),
    );
    if (entries.length > 0) {
      await rememberCompanies(ctx, entries);
    }
    return { companies: entries, source: "live" };
  } catch (err) {
    return {
      companies: await readCompanyDirectory(ctx),
      source: "cache",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CompanyResolution {
  match?: CompanyDirectoryEntry;
  /** Everything we could offer as an alternative, for the "not found" message. */
  known: CompanyDirectoryEntry[];
  source: "live" | "cache";
  error?: string;
}

/**
 * Resolve a `/connect` argument to a company by id or (case-insensitive) name.
 *
 * A bare company UUID is additionally confirmed with `ctx.companies.get()`, so
 * an operator can always link a chat by id even when the directory is empty —
 * that single-company call is exactly what the proactive gate admits.
 */
export async function resolveCompanyInput(
  ctx: PluginContext,
  input: string,
): Promise<CompanyResolution> {
  const needle = input.trim();
  const lookup = await listCompaniesResilient(ctx);

  const match = lookup.companies.find(
    (company) => company.id === needle || company.name?.toLowerCase() === needle.toLowerCase(),
  );
  if (match) {
    return { match, known: lookup.companies, source: lookup.source, error: lookup.error };
  }

  if (UUID_RE.test(needle)) {
    try {
      const company = await ctx.companies.get(needle);
      if (company?.id) {
        const entry: CompanyDirectoryEntry = {
          id: company.id,
          ...((company as { name?: string }).name ? { name: (company as { name?: string }).name } : {}),
        };
        await rememberCompanies(ctx, [entry]);
        return { match: entry, known: lookup.companies, source: lookup.source, error: lookup.error };
      }
    } catch (err) {
      return {
        known: lookup.companies,
        source: lookup.source,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { known: lookup.companies, source: lookup.source, error: lookup.error };
}

/** Human-readable list for command output. */
export function formatCompanyChoices(companies: CompanyDirectoryEntry[]): string {
  return companies.map((company) => company.name || company.id).join(", ");
}
