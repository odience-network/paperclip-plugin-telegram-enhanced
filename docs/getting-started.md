# Getting Started

This guide takes you from zero to receiving your first Telegram notification — and tapping **Approve** without leaving the chat.

> **Time required:** ~5–10 minutes.
> **You'll need:** a Telegram account and access to a Paperclip company.

## 1. Create a Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (bot name, then username).
3. Copy the **bot token** BotFather gives you. Keep it private — anyone with this token controls your bot.

## 2. Find your chat ID

The plugin needs to know *where* to send notifications.

1. Send any message to your new bot (or add it to a group and send a message there).
2. Run:

   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
   ```

3. In the JSON response, find the `chat.id` value. That's your `defaultChatId`.

> **Tip:** Group chat IDs are negative numbers (e.g. `-100123456789`). That's expected.

## 3. Install the plugin

Install from npm:

```bash
npm install @odience-network/paperclip-plugin-telegram-enhanced
```

Or register it directly with a running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@odience-network/paperclip-plugin-telegram-enhanced"}'
```

## 4. Connect your bot (instance-wide)

The plugin runs **instance-wide** — one bot serves every company on the instance. Connect the bot once from the settings page:

1. Open the Telegram plugin **Settings** page.
2. In the **Bot Connection** section, paste your bot token from @BotFather.
3. Click **Connect bot**.

The token is validated live against Telegram (`getMe`) and stored **server-side in instance-scoped plugin state**. It is never shown again in the UI, and it is **not** a per-company secret — so every company can reach the board through this one bot.

> **Why not a company secret?** The bot is shared across all companies, so a single company-scoped secret is the wrong scope. The instance connection is also compatible with recent `paperclipai` master, which disables plugin secret-refs (post-#5429). See [Troubleshooting](troubleshooting.md#plugin-wont-activate--secret-references-rejected).
>
> **Legacy / advanced:** the old `telegramBotTokenRef` secret-UUID field still works as a fallback (under **Connection & URLs → advanced**) for existing installs.

## 5. Configure the plugin

Open the plugin settings and set, at minimum:

| Setting | Value |
|---------|-------|
| Bot token | Connected in step 4 (**Bot Connection** section). |
| `defaultChatId` | The chat ID from step 2. |

Save the settings. You should now receive notifications when issues are created or completed.

> See the **[Configuration Reference](configuration.md)** for the full list of settings, including per-type chat routing, digests, and escalation.

## 6. Enable approval buttons (board access)

Approval **Approve** / **Reject** buttons and the `/approve <id>` command call Paperclip's approval APIs. Authenticated deployments require a board API token for those mutations.

To connect board access:

1. Open the Telegram plugin settings page **inside a company**.
2. Click **Connect board access**.
3. Approve the Paperclip board-access request in the window that opens.

The plugin stores the resulting board API token as a Paperclip company secret and keeps only the secret reference in its state. (The advanced `paperclipBoardApiTokenRef` config field is still supported for manual setups.)

## 7. Secure inbound interactions

Telegram has no BotFather setting to block direct messages while still allowing group use. If you enable `enableCommands` or `enableInbound`, lock down who can interact with your bot using one or both allowlists:

- **`allowedTelegramUserIds`** — which Telegram user IDs may interact.
- **`allowedTelegramChatIds`** — which chats interactions are accepted from.

If both are set, **both must match**: the user must be on the user allowlist *and* the message must come from an allowed chat. The allowlists apply to bot commands, inbound replies, media intake, and inline button callbacks.

Leave an allowlist empty only if that dimension should be unrestricted. After changing allowlists, save the settings and restart the plugin if the new values aren't picked up immediately.

---

## Next steps

- 🔔 Tune what you get notified about → [Notifications & Routing](notifications.md)
- 💬 Learn the bot commands → [Bot Commands](commands.md)
- 🧵 Run multiple agents in a thread → [Agent Tools](agent-tools.md)
- 🛠️ Hit a snag? → [Troubleshooting](troubleshooting.md)
