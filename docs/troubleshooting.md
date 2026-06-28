# Troubleshooting

Common problems and how to fix them. If something isn't covered here, open an issue on the repository.

## Plugin won't activate / secret references rejected

**Symptom:** activation fails with `Plugin secret references are disabled until company-scoped plugin config lands`, or `POST /api/plugins/:id/config` returns **HTTP 422** for configs containing secret-ref UUIDs (e.g. `telegramBotTokenRef`).

**Cause:** You're running `paperclipai` **master** after [#5429](https://github.com/paperclipai/paperclip/pull/5429) (2026-05-09). The new Secrets Manager ships with a temporary kill switch on plugin secret-ref UUIDs while a company-scoped `plugin_config` follow-up lands. This is intentional **fail-closed** mitigation (PAP-2394 — see the [upstream plan doc](https://github.com/paperclipai/paperclip/blob/master/doc/plans/2026-04-26-plugin-secret-ref-company-scope.md)).

**Fix (v0.3.0+):** Stop using the secret-ref field for the bot token. Open the plugin **Settings → Bot Connection** and paste the bot token directly (see [Getting Started](getting-started.md#4-connect-your-bot-instance-wide)). The token is stored in **instance-scoped plugin state**, not via a company secret-ref, so it is unaffected by the #5429 kill switch and works on current master. Leave `telegramBotTokenRef` blank.

## "Token must be a UUID" / activation fails after upgrade

**Symptom:** the plugin refuses to activate and complains about the token field.

**Cause:** Between **v0.2.1** and **v0.2.x**, `telegramBotTokenRef` required a Paperclip **secret reference (a UUID)** in the **Connection & URLs** field, and rejected a raw token pasted there.

**Fix (v0.3.0+):** Don't paste the token into the secret-ref field. Use **Settings → Bot Connection** and paste the raw bot token there — it is validated and stored instance-wide. The legacy `telegramBotTokenRef` field is now optional; if you do use it, it must still be a secret **UUID**.

## No notifications arriving

- Confirm a bot is connected under **Settings → Bot Connection** (or a valid `telegramBotTokenRef` secret **UUID** for legacy installs).
- Confirm `defaultChatId` (or the relevant per-type chat ID) is set and correct. Group IDs are negative numbers.
- Make sure you've sent at least one message to the bot (or added it to the group) so Telegram will deliver to it.
- Check that the relevant `notifyOn*` toggle is enabled — see the [Configuration Reference](configuration.md#notification-toggles).

## Approval buttons don't work

Approval **Approve** / **Reject** buttons and `/approve` call Paperclip's approval APIs, which require **board access** on authenticated deployments.

**Fix:** Connect board access from the plugin settings page (**Connect board access**), or set `paperclipBoardApiTokenRef` manually. See [Getting Started → board access](getting-started.md#6-enable-approval-buttons-board-access).

**Board behind Cloudflare Access?** A bearer token alone is rejected with a login challenge, so buttons and `/approve` fail silently. Point `paperclipBaseUrl` at an internal address that bypasses Access, or configure a service token (`cfAccessClientIdRef` + `cfAccessClientSecretRef`). Full walkthrough: [Cloudflare Access](cloudflare-access.md).

## Deep-link (`url:`) buttons open a login page

**Open `<issue>` ↗**, agent, and **View Run ↗** buttons are `url:` links that open the **public UI** (`paperclipPublicUrl`) in the user's browser. Behind Cloudflare Access they hit a login challenge unless the browser already has an authenticated Access session — a service token does **not** help here (only the browser session does).

**Fix:** Rely on the in-chat `callback_data` actions (Approve/Reject etc.), add a Cloudflare Access bypass policy for the read-only deep-link paths, or suppress `url:` buttons. See [Cloudflare Access → `url:` button caveat](cloudflare-access.md#caveat-url-deep-link-buttons-behind-access).

## Commands or replies are ignored

- Make sure `enableCommands` (for commands) and `enableInbound` (for replies) are enabled.
- Check your [security allowlists](getting-started.md#7-secure-inbound-interactions): if `allowedTelegramUserIds` and/or `allowedTelegramChatIds` are set, the user **and** chat must match.
- After changing allowlists or other settings, save and restart the plugin if values aren't picked up immediately.

## Topic routing isn't working

- `topicRouting` must be `true`.
- The group must have **forum topics enabled**.
- Digest messages in forum groups fall back to the **General** topic if no `digestTopicId` is set.

See [Notifications & Routing](notifications.md#forum-topic-routing).

## Voice/audio isn't transcribed

- Set `transcriptionApiKeyRef` to a secret reference for an OpenAI API key (used by Whisper).
- Confirm the media is being routed to an agent thread or a configured Brief Agent intake channel (`briefAgentChatIds`).

---

← Back to [Documentation](README.md)
