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

## 8. Running multiple companies on one instance

Steps 1–7 cover a single company. For a Paperclip instance that hosts more than one company, each company gets its own Telegram group and its own settings — but shares the one bot you connected in step 4:

1. **Connect one bot for the whole instance** — done once, in step 4. Every company below reuses it.
2. **Create one Telegram group per company.**
3. **Add the bot to each group**, with [group privacy mode off](https://core.telegram.org/bots/features#privacy-mode) so it can read `/connect` and other commands in the group.
4. **Run `/connect <company-name>` in each group.** This links that specific chat to that specific company — it never links a chat to more than one company, and a chat left unlinked only answers `/start`, `/help`, and `/connect` until you do this.
5. **Set Chat ID / approvals chat / board token in each company's own plugin settings** — open the Telegram plugin settings *from inside that company* (not another one) and save its `defaultChatId`, `approvalsChatId`, and board access there. Settings saved for one company are never used for another company's sends or notifications.
6. **Verify with `/status`** in each group — it should report that company's agents and issues, not another company's.

Run `/connect` with no argument in any chat to see every company the instance knows about.

---

## Next steps

- 🔔 Tune what you get notified about → [Notifications & Routing](notifications.md)
- 💬 Learn the bot commands → [Bot Commands](commands.md)
- 🧵 Run multiple agents in a thread → [Agent Tools](agent-tools.md)
- 🛠️ Hit a snag? → [Troubleshooting](troubleshooting.md)
