import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Emits a host event, awaiting the result so a rejection (or a synchronous
 * throw from the host RPC proxy, e.g. an uninitialized transport) is caught
 * and logged instead of silently dropped or escaping to the caller.
 *
 * A plain `ctx.events.emit(...).catch(...)` only guards a rejected promise;
 * it does nothing if the proxy throws before returning one, which is why
 * this wraps the call in try/catch rather than chaining `.catch()`.
 */
export async function emitOrLog(
  ctx: PluginContext,
  event: string,
  companyId: string,
  payload: Record<string, unknown>,
  site: string,
  ids: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.events.emit(event, companyId, payload);
  } catch (err) {
    ctx.logger.error("Failed to emit host event", {
      event,
      type: typeof payload.type === "string" ? payload.type : undefined,
      site,
      companyId,
      ...ids,
      error: String(err),
    });
  }
}
