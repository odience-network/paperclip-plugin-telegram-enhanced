// Graceful handling of disabled/failed plugin secret resolution.
//
// Upstream: mvanhorn/paperclip-plugin-telegram@8a0e579
//   "fix: handle disabled secret resolution gracefully" (zocomputer, 2026-06-28)
// Integrated for ODIAA-935. Complements our existing kill-switch tracking:
//   - 67061b5 (post-#5429 plugin secret-ref kill switch callout)
//   - #56/#57 (validate secret-ref fields as UUIDs at config-save time)
//
// When the post-#5429 plugin secret-ref kill switch is active (or company-scoped
// plugin config has not yet landed), `ctx.secrets.resolve` throws. This helper
// degrades gracefully instead of crashing: it records an operator-facing
// "degraded" runtime health diagnostic, logs the error, and returns undefined so
// the worker can skip token-bound runtime features rather than die on an
// unhandled rejection.
import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";
import { toSecretRefBinding } from "./secret-ref-validation.js";

export type TelegramRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_DISABLED_MESSAGE =
  "Plugin secret references are disabled until company-scoped plugin config lands";
export const SECRET_RESOLUTION_ISSUE_URL =
  "https://github.com/mvanhorn/paperclip-plugin-telegram/issues/63";

/**
 * Resolve a secret reference on any host generation.
 *
 * Hosts from 2026.8xx only resolve `{ type: "secret_ref" }` bindings, need the
 * company (a worker loop such as Telegram polling has no invocation scope, and
 * the company is what admits the call), and look the secret up by the config
 * path that bound it to the plugin. Older hosts take the bare UUID, so that is
 * the fallback.
 */
export async function resolveSecretRef(
  ctx: PluginContext,
  ref: unknown,
  opts: { companyId?: string | null; configPath?: string } = {},
): Promise<string> {
  const binding = toSecretRefBinding(ref);
  if (!binding) throw new Error("Invalid secret reference");
  let currentHostError: unknown;
  if (opts.companyId) {
    try {
      return await ctx.secrets.resolve(binding, {
        companyId: opts.companyId,
        ...(opts.configPath ? { configPath: opts.configPath } : {}),
      });
    } catch (err) {
      currentHostError = err;
    }
  }
  try {
    return await ctx.secrets.resolve(binding.secretId);
  } catch (err) {
    // On a current host the bare-UUID retry always fails; the first error is the real one.
    throw currentHostError ?? err;
  }
}

export async function resolveStartupTelegramBotToken(
  ctx: PluginContext,
  tokenRef: string,
  setHealth: (health: TelegramRuntimeHealth) => void,
): Promise<string | undefined> {
  try {
    const token = await ctx.secrets.resolve(tokenRef);
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = String(err);
    setHealth({
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    });
    ctx.logger.error(
      "Telegram plugin cannot resolve bot token secret; runtime features are disabled",
      {
        error,
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    );
    return undefined;
  }
}
