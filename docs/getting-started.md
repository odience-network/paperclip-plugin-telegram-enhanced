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

## 4. Store your bot token as a Paperclip secret

For security, the plugin references your bot token by a **secret UUID** rather than storing the raw value. Create the secret first, then reference it.

You can do this two ways:

### Option A — Paperclip UI

1. Open any agent's **Configuration → Environment variables**.
2. Enter a name (e.g. `telegram-bot-token`) and paste the bot token as the value.
3. Click **Create / Seal**.

The secret is created at the **company level** (not bound to that agent, despite the agent-context UI), and the returned UUID can be used by any plugin in the company.

### Option B — REST API

```bash
curl -X POST http://127.0.0.1:3100/api/companies/{companyId}/secrets \
  -H "Content-Type: application/json" \
  -d '{"name":"telegram-bot-token","value":"<your-bot-token>","provider":"local_encrypted"}'
```

The response contains the secret's **UUID**. Copy it — you'll paste it into `telegramBotTokenRef` next.

## 5. Configure the plugin

Open the plugin settings and set, at minimum:

| Setting | Value |
|---------|-------|
| `telegramBotTokenRef` | The secret **UUID** from step 4. |
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
