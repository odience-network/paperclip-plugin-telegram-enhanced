// Ported from ant013/paperclip-plugin-telegram (TEL-23, commit 45fea97):
// "route Telegram file sends by project key". Self-contained validation and
// destination-resolution helpers for outbound Telegram file routing.

export type TelegramFileRoute = {
  name?: unknown;
  enabled?: unknown;
  projectKey?: unknown;
  chatId?: unknown;
  topicId?: unknown;
};

export type NormalizedTelegramFileRoute = {
  name: string;
  projectKey: string;
  chatId: string;
  topicId?: number;
};

export type FileRouteValidationIssue = {
  index?: number;
  field: "fileRoutes" | "name" | "projectKey" | "chatId" | "topicId";
  message: string;
};

export type FileRouteValidationResult = {
  routes: NormalizedTelegramFileRoute[];
  issues: FileRouteValidationIssue[];
  duplicateProjectKeys: string[];
};

export type TelegramFileDestination =
  | {
    ok: true;
    chatId: string;
    topicId?: number;
    source: "explicit" | "file_route" | "legacy_fallback";
    routeName?: string;
    projectKey?: string;
    issueIdentifier?: string;
  }
  | {
    ok: false;
    code:
      | "missing_destination"
      | "missing_route_context"
      | "unknown_project_route"
      | "ambiguous_route"
      | "invalid_route_config"
      | "conflicting_destination"
      | "unresolved_issue";
    message: string;
    projectKey?: string;
    issueIdentifier?: string;
  };

export type TelegramFileDestinationRequest = {
  explicitChatId?: string | null;
  explicitThreadId?: number;
  issueId?: string | null;
  issueIdentifier?: string | null;
  projectKey?: string | null;
  lookupIssueIdentifier?: (issueId: string) => Promise<string | null>;
};

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;
const ISSUE_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]*)-\d+$/;
const CHAT_ID_PATTERN = /^-?\d+$/;
const TOPIC_ID_PATTERN = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function routeEnabled(value: unknown): boolean {
  return value !== false;
}

export function normalizeProjectKey(value: unknown): string | null {
  const normalized = cleanString(value).toUpperCase();
  return PROJECT_KEY_PATTERN.test(normalized) ? normalized : null;
}

export function parseProjectKeyFromIssueIdentifier(value: unknown): string | null {
  const issueIdentifier = cleanString(value).toUpperCase();
  const match = ISSUE_IDENTIFIER_PATTERN.exec(issueIdentifier);
  return match?.[1] ?? null;
}

export function validateTelegramFileRoutes(value: unknown): FileRouteValidationResult {
  const routes: NormalizedTelegramFileRoute[] = [];
  const issues: FileRouteValidationIssue[] = [];

  if (value === undefined || value === null) {
    return { routes, issues, duplicateProjectKeys: [] };
  }

  if (!Array.isArray(value)) {
    return {
      routes,
      issues: [{ field: "fileRoutes", message: "fileRoutes must be an array." }],
      duplicateProjectKeys: [],
    };
  }

  for (const [index, route] of value.entries()) {
    if (!isRecord(route)) {
      issues.push({ index, field: "fileRoutes", message: "Enabled file routes must be objects." });
      continue;
    }

    if (!routeEnabled(route.enabled)) {
      continue;
    }

    const name = cleanString(route.name);
    const projectKey = cleanString(route.projectKey);
    const chatId = cleanString(route.chatId);
    const rawTopicId = cleanString(route.topicId);
    let valid = true;

    if (!name) {
      issues.push({ index, field: "name", message: "Enabled file routes need a name." });
      valid = false;
    }
    if (!PROJECT_KEY_PATTERN.test(projectKey)) {
      issues.push({ index, field: "projectKey", message: "Project key must use uppercase letters and numbers." });
      valid = false;
    }
    if (!CHAT_ID_PATTERN.test(chatId)) {
      issues.push({ index, field: "chatId", message: "Enabled file routes need a numeric Telegram chat ID." });
      valid = false;
    }
    if (rawTopicId && !TOPIC_ID_PATTERN.test(rawTopicId)) {
      issues.push({ index, field: "topicId", message: "Topic ID must be numeric when provided." });
      valid = false;
    }

    if (valid) {
      routes.push({
        name,
        projectKey,
        chatId,
        topicId: rawTopicId ? Number(rawTopicId) : undefined,
      });
    }
  }

  const duplicateNames = findDuplicates(routes.map((route) => route.name));
  for (const name of duplicateNames) {
    issues.push({ field: "name", message: `Enabled file route names must be unique: ${name}.` });
  }

  return {
    routes,
    issues,
    duplicateProjectKeys: findDuplicates(routes.map((route) => route.projectKey)),
  };
}

export function getTelegramFileRouteSaveErrors(value: unknown): string[] {
  const validation = validateTelegramFileRoutes(value);
  return [
    ...validation.issues.map((issue) => issue.message),
    ...validation.duplicateProjectKeys.map((projectKey) =>
      `Enabled file routes must not duplicate project key ${projectKey}.`
    ),
  ];
}

export async function resolveTelegramFileDestination(
  fileRoutes: unknown,
  request: TelegramFileDestinationRequest,
): Promise<TelegramFileDestination> {
  const hasExplicitChat = Boolean(request.explicitChatId);
  const hasExplicitThread = request.explicitThreadId !== undefined;
  const hasRouteInput = Boolean(request.projectKey || request.issueIdentifier || request.issueId);

  if (!hasRouteInput) {
    if (hasExplicitChat) {
      return { ok: true, source: "explicit", chatId: request.explicitChatId! };
    }
    return { ok: true, source: "legacy_fallback", chatId: "" };
  }

  if (hasExplicitChat || hasExplicitThread) {
    return {
      ok: false,
      code: "conflicting_destination",
      message: "Route-aware Telegram file sends cannot also set chatId or threadId.",
    };
  }

  const routeContext = await resolveRouteContext(request);
  if (!routeContext.ok) return routeContext;

  const validation = validateTelegramFileRoutes(fileRoutes);
  if (validation.issues.length > 0) {
    return {
      ok: false,
      code: "invalid_route_config",
      message: "Telegram file route configuration has invalid enabled routes.",
      projectKey: routeContext.projectKey,
      issueIdentifier: routeContext.issueIdentifier,
    };
  }

  const matches = validation.routes.filter((route) => route.projectKey === routeContext.projectKey);
  if (matches.length === 0) {
    return {
      ok: false,
      code: "unknown_project_route",
      message: `No enabled Telegram file route matches project key ${routeContext.projectKey}.`,
      projectKey: routeContext.projectKey,
      issueIdentifier: routeContext.issueIdentifier,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      code: "ambiguous_route",
      message: `Multiple enabled Telegram file routes match project key ${routeContext.projectKey}.`,
      projectKey: routeContext.projectKey,
      issueIdentifier: routeContext.issueIdentifier,
    };
  }

  const route = matches[0]!;
  return {
    ok: true,
    source: "file_route",
    chatId: route.chatId,
    topicId: route.topicId,
    routeName: route.name,
    projectKey: route.projectKey,
    issueIdentifier: routeContext.issueIdentifier,
  };
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates].sort();
}

async function resolveRouteContext(
  request: TelegramFileDestinationRequest,
): Promise<
  | { ok: true; projectKey: string; issueIdentifier?: string }
  | Extract<TelegramFileDestination, { ok: false }>
> {
  const issueId = cleanString(request.issueId);
  let resolvedIssueIdentifier: string | undefined;
  if (issueId) {
    const lookupResult = await request.lookupIssueIdentifier?.(issueId);
    if (!lookupResult) {
      return {
        ok: false,
        code: "unresolved_issue",
        message: "Could not resolve the Paperclip issue for Telegram file routing.",
      };
    }
    resolvedIssueIdentifier = lookupResult.toUpperCase();
  }

  const explicitProjectKey = normalizeProjectKey(request.projectKey);
  if (explicitProjectKey) {
    return {
      ok: true,
      projectKey: explicitProjectKey,
      issueIdentifier: cleanString(request.issueIdentifier).toUpperCase() || resolvedIssueIdentifier,
    };
  }

  const issueIdentifier = cleanString(request.issueIdentifier).toUpperCase() || resolvedIssueIdentifier;
  const projectKeyFromIdentifier = parseProjectKeyFromIssueIdentifier(issueIdentifier);
  if (projectKeyFromIdentifier) {
    return {
      ok: true,
      projectKey: projectKeyFromIdentifier,
      issueIdentifier,
    };
  }

  if (resolvedIssueIdentifier) {
    return {
      ok: false,
      code: "missing_route_context",
      message: "Resolved issue identifier does not contain a routable project key.",
      issueIdentifier: resolvedIssueIdentifier,
    };
  }

  return {
    ok: false,
    code: "missing_route_context",
    message: "Telegram file routing needs projectKey, issueIdentifier, or issueId.",
  };
}
