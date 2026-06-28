/**
 * Paperclip interaction response API client.
 *
 * Ported from tue-Jonas/paperclip-plugin-telegram (TWX-46). Provides a
 * dependency-free interface for fetching interaction details and posting
 * accept/reject/respond actions back to the Paperclip board API.
 *
 * This module depends only on an HttpClientLike interface (ctx.http.fetch)
 * and does not import PluginContext directly, making it easy to mock and test.
 */

type HttpResponseLike = {
  ok?: boolean;
  status?: number;
  text?: () => Promise<string>;
};

export type HttpClientLike = {
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<HttpResponseLike>;
};

type InteractionAction = "accept" | "reject" | "respond";

export type FetchInteractionInput = {
  baseUrl: string;
  issueId: string;
  interactionId: string;
  boardApiToken: string;
};

export type RespondInteractionInput = {
  baseUrl: string;
  issueId: string;
  interactionId: string;
  action: InteractionAction;
  boardApiToken: string;
  reason?: string;
  answers?: Array<{ questionId: string; optionIds: string[] }>;
};

export type InteractionRecord = Record<string, unknown>;

function requireBoardToken(boardApiToken: string): void {
  if (!boardApiToken) {
    throw new Error("Board API token missing (set boardApiToken or boardApiTokenRef)");
  }
}

function boardHeaders(boardApiToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${boardApiToken}`,
  };
}

async function readErrorDetail(response: HttpResponseLike): Promise<string> {
  try {
    return ((await response.text?.()) ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

async function readJson(response: HttpResponseLike): Promise<unknown> {
  const raw = await response.text?.();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function fetchInteraction(
  http: HttpClientLike,
  input: FetchInteractionInput,
): Promise<InteractionRecord | null> {
  const { baseUrl, issueId, interactionId, boardApiToken } = input;
  requireBoardToken(boardApiToken);

  const response = await http.fetch(`${baseUrl}/api/issues/${issueId}/interactions`, {
    method: "GET",
    headers: boardHeaders(boardApiToken),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const status = response.status ?? 0;
    throw new Error(`Interaction list fetch failed (${status})${detail ? `: ${detail}` : ""}`);
  }

  const parsed = await readJson(response);
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed) {
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).id === interactionId) {
      return raw as InteractionRecord;
    }
  }
  return null;
}

export async function respondInteraction(
  http: HttpClientLike,
  input: RespondInteractionInput,
): Promise<void> {
  const { baseUrl, issueId, interactionId, action, boardApiToken } = input;
  requireBoardToken(boardApiToken);

  const body: Record<string, unknown> = {};
  if (action === "reject" && input.reason) body.reason = input.reason;
  if (action === "respond") {
    body.answers = input.answers ?? [];
  }

  const response = await http.fetch(
    `${baseUrl}/api/issues/${issueId}/interactions/${interactionId}/${action}`,
    {
      method: "POST",
      headers: boardHeaders(boardApiToken),
      body: JSON.stringify(body),
    },
  );

  if (response.ok) return;

  const detail = await readErrorDetail(response);
  const status = response.status ?? 0;
  throw new Error(`Interaction ${action} failed (${status})${detail ? `: ${detail}` : ""}`);
}
