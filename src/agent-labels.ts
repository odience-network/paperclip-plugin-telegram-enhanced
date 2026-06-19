import type { PluginContext } from "@paperclipai/plugin-sdk";

type AgentRecord = Record<string, unknown>;

export type ResolvedAgent = {
  id: string;
  name: string;
};

export type AgentLabelCache = Map<string, string>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getAgentId(agent: AgentRecord): string | null {
  const candidateId = nonEmptyString(agent.agentId) ?? nonEmptyString(agent._id) ?? nonEmptyString(agent.id);
  if (!candidateId) return null;
  if (UUID_RE.test(candidateId)) return candidateId;
  return nonEmptyString(agent.id) ?? candidateId;
}

function getAgentName(agent: AgentRecord): string | null {
  return nonEmptyString(agent.name) ?? nonEmptyString(agent.displayName);
}

function getAgentsApi(ctx: PluginContext): Record<string, unknown> {
  return ctx.agents as unknown as Record<string, unknown>;
}

export function displayNameFromFields(...values: unknown[]): string | null {
  for (const value of values) {
    const label = nonEmptyString(value);
    if (label) return label;
  }
  return null;
}

export async function resolveAgentDisplayName(
  ctx: PluginContext,
  companyId: string,
  agentId: unknown,
  options: { cache?: AgentLabelCache; fallbackName?: string | null } = {},
): Promise<string | null> {
  const id = nonEmptyString(agentId);
  if (!id) return options.fallbackName ?? null;

  const cacheKey = `${companyId}:${id}`;
  const cached = options.cache?.get(cacheKey);
  if (cached) return cached;

  const agentsApi = getAgentsApi(ctx);
  const getAgent = agentsApi.get;
  if (typeof getAgent === "function") {
    try {
      const agent = await getAgent.call(ctx.agents, id, companyId);
      if (agent && typeof agent === "object") {
        const name = getAgentName(agent as AgentRecord);
        if (name) {
          options.cache?.set(cacheKey, name);
          return name;
        }
      }
    } catch (err) {
      ctx.logger.warn("Failed to resolve agent display name", {
        agentId: id,
        companyId,
        error: String(err),
      });
    }
  }

  return options.fallbackName ?? null;
}

export async function resolveAgentByName(
  ctx: PluginContext,
  name: string,
  companyId: string,
): Promise<ResolvedAgent | null> {
  const query = nonEmptyString(name);
  if (!query) return null;

  const agentsApi = getAgentsApi(ctx);
  const listAgents = agentsApi.list;
  if (typeof listAgents !== "function") return null;

  try {
    const allAgents = await listAgents.call(ctx.agents, { companyId });
    if (!Array.isArray(allAgents)) return null;

    const lower = query.toLowerCase();
    const match = (allAgents as AgentRecord[]).find((agent) => {
      const agentName = nonEmptyString(agent.name);
      const displayName = nonEmptyString(agent.displayName);
      const urlKey = nonEmptyString(agent.urlKey);
      return agentName?.toLowerCase() === lower
        || displayName?.toLowerCase() === lower
        || urlKey?.toLowerCase() === lower;
    });
    if (!match) return null;

    const id = getAgentId(match);
    const resolvedName = getAgentName(match);
    if (!id || !resolvedName) return null;
    return { id, name: resolvedName };
  } catch (err) {
    ctx.logger.error("Failed to resolve agent by name", {
      agentName: query,
      companyId,
      error: String(err),
    });
    return null;
  }
}
