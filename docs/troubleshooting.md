# Troubleshooting

Common problems and how to fix them. If something isn't covered here, open an issue on the repository.

## Plugin won't activate / secret references rejected

**Symptom:** activation fails with `Plugin secret references are disabled until company-scoped plugin config lands`, or `POST /api/plugins/:id/config` returns **HTTP 422** for configs containing secret-ref UUIDs (e.g. `telegramBotTokenRef`).

**Cause:** You're running `paperclipai` **master** after [#5429](https://github.com/paperclipai/paperclip/pull/5429) (2026-05-09). The new Secrets Manager ships with a temporary kill switch on plugin secret-ref UUIDs while a company-scoped `plugin_config` follow-up lands. This is intentional **fail-closed** mitigation (PAP-2394 — see the [upstream plan doc](https://github.com/paperclipai/paperclip/blob/master/doc/plans/2026-04-26-plugin-secret-ref-company-scope.md)).

**Fix:** Until the follow-up lands, **pin to the last `paperclipai` release before #5429**. This restriction will be lifted once secret-ref resolution is restored.

## "Token must be a UUID" / activation fails after upgrade

**Symptom:** the plugin refuses to activate and complains about the token field.

**Cause:** As of **v0.2.1**, `telegramBotTokenRef` and `transcriptionApiKeyRef` require a Paperclip **secret reference (a UUID)**, not the raw token value.

**Fix — migrate your token:**

1. Create a company secret holding your bot token (UI or REST API) — see [Getting Started](getting-started.md#4-store-your-bot-token-as-a-paperclip-secret).
2. Copy the returned secret **UUID**.
3. Open **Plugin Settings for Telegram Bot** and paste the UUID into **Telegram Bot Token**.
4. Save and restart the plugin.

The plugin will not activate while a raw (non-UUID) token is in the field.

## No notifications arriving

- Confirm `telegramBotTokenRef` points to a valid secret **UUID**, not a raw token.
- Confirm `defaultChatId` (or the relevant per-type chat ID) is set and correct. Group IDs are negative numbers.
- Make sure you've sent at least one message to the bot (or added it to the group) so Telegram will deliver to it.
- Check that the relevant `notifyOn*` toggle is enabled — see the [Configuration Reference](configuration.md#notification-toggles).

## Approval buttons don't work

Approval **Approve** / **Reject** buttons and `/approve` call Paperclip's approval APIs, which require **board access** on authenticated deployments.

**Fix:** Connect board access from the plugin settings page (**Connect board access**), or set `paperclipBoardApiTokenRef` manually. See [Getting Started → board access](getting-started.md#6-enable-approval-buttons-board-access).

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
