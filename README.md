# Telegram Bot for Paperclip — Notifications, Approvals & Multi-Agent Chat Ops

[![npm](https://img.shields.io/npm/v/paperclip-plugin-telegram)](https://www.npmjs.com/package/paperclip-plugin-telegram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Run your [Paperclip](https://github.com/paperclipai/paperclip) AI agents from Telegram. Get instant notifications, approve requests with one tap, chat with multiple agents in a thread, send voice notes that turn into tasks, and build your own slash commands — all without leaving your chat app.

**Telegram + Paperclip in one bidirectional bridge.** This plugin turns a Telegram bot into a command center for your AI agents: push notifications flow *out* to your chats, and commands, replies, approvals, and media flow *back in* to Paperclip.

```text
Paperclip agents  ⇄  Telegram bot  ⇄  You
   notifications   →   📲 chats     →  tap to approve, reply, chat
   issues & tools  ←   💬 commands  ←  /status, voice notes, @mentions
```

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start-5-minutes)
- [Documentation](#documentation)
- [Configuration at a glance](#configuration-at-a-glance)
- [Agent tools](#agent-tools)
- [Compatibility note](#compatibility-note-paperclipai-master)
- [Why this plugin](#why-this-plugin)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

---

## Features

| | Feature | What you get |
|---|---|---|
| 🔔 | **Notifications** | Issue created/done, approvals, agent errors, and run lifecycle — formatted in MarkdownV2 with a plain-text fallback. |
| ✅ | **One-tap approvals** | Inline **Approve** / **Reject** buttons on every approval. Act without leaving Telegram. |
| 💬 | **Bot commands** | `/status`, `/issues`, `/agents`, `/approve`, `/connect`, `/topics`, `/acp`, `/commands`, and more. |
| ↩️ | **Reply routing** | Reply to any notification and it becomes an issue comment or escalation reply. |
| 🧵 | **Multi-agent threads** | Up to 5 agents per thread with `@mention` routing, handoff, and discuss loops. |
| 🆘 | **Human-in-the-loop escalation** | Agents escalate when stuck; you get context, a suggested reply, and action buttons. |
| 🎙️ | **Media-to-task pipeline** | Voice, audio, video, photos, and documents routed to agents — with Whisper transcription. |
| 🗂️ | **Forum topic routing** | Map Telegram forum topics to Paperclip projects so updates land in the right place. |
| 📊 | **Daily digest** | Once, twice, or three times a day: completions, active agents, and open work. |
| ⚙️ | **Custom workflow commands** | Import multi-step workflows as your own `/slash` commands. |
| 🤖 | **Proactive suggestions** | Agents register watches (e.g. *overdue invoice*) that fire suggestions when conditions hit. |

➡️ **Full feature reference:** see the [documentation](#documentation) below.

---

## Quick start (5 minutes)

**1. Create a Telegram bot**

Message [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the bot token.

**2. Find your chat ID**

Send any message to your new bot, then run:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
```

Copy the `chat.id` from the response.

**3. Install the plugin**

```bash
npm install paperclip-plugin-telegram
```

Or register it with a running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-telegram"}'
```

**4. Store your bot token as a Paperclip secret**

Create a company secret for the token and copy its UUID — you'll reference it instead of pasting the raw token.

```bash
curl -X POST http://127.0.0.1:3100/api/companies/{companyId}/secrets \
  -H "Content-Type: application/json" \
  -d '{"name":"telegram-bot-token","value":"<your-bot-token>","provider":"local_encrypted"}'
```

**5. Configure the plugin**

Set `telegramBotTokenRef` to the secret UUID and `defaultChatId` to your chat ID. Save, and you'll start receiving notifications.

📘 **Need the detailed walkthrough?** Read the [Getting Started guide](docs/getting-started.md) — it covers the settings UI, board access for approvals, and security allowlists.

---

## Documentation

| Guide | What's inside |
|-------|---------------|
| **[Getting Started](docs/getting-started.md)** | Step-by-step setup, secrets, board access, and security allowlists. |
| **[Configuration Reference](docs/configuration.md)** | Every config setting, default, and what it does. |
| **[Notifications & Routing](docs/notifications.md)** | Notification types, per-type chats, forum topics, and digests. |
| **[Bot Commands](docs/commands.md)** | Full command reference with examples. |
| **[Agent Tools](docs/agent-tools.md)** | Escalation, multi-agent threads, handoff/discuss, and watches. |
| **[Workflow Commands](docs/workflow-commands.md)** | Build and run your own multi-step `/slash` commands. |
| **[Troubleshooting](docs/troubleshooting.md)** | Common issues, compatibility notes, and fixes. |

---

## Configuration at a glance

Only one setting is required to get started:

| Setting | Required | Description |
|---------|----------|-------------|
| `telegramBotTokenRef` | ✅ Yes | Secret UUID for your bot token. |
| `defaultChatId` | No | Fallback chat for notifications. |
| `digestMode` | No | `off`, `daily`, `bidaily`, or `tridaily`. |
| `enableCommands` | No | Enable bot commands (default: `true`). |
| `enableInbound` | No | Route Telegram replies back to Paperclip (default: `true`). |

See the **[full configuration reference](docs/configuration.md)** for all 30+ settings, including per-type chat routing, escalation timeouts, media intake, and proactive-suggestion limits.

---

## Agent tools

Your Paperclip agents can call these tools to drive Telegram interactions:

| Tool | Description |
|------|-------------|
| `escalate_to_human` | Escalate a conversation to a human when confidence is low. |
| `handoff_to_agent` | Hand off work to another agent in the thread. |
| `discuss_with_agent` | Start a back-and-forth conversation with another agent. |
| `register_watch` | Register a proactive watch that monitors entities and sends suggestions. |

Details and parameters are in the **[Agent Tools guide](docs/agent-tools.md)**.

---

## Compatibility note (`paperclipai` master)

> **Running `paperclipai` master after [#5429](https://github.com/paperclipai/paperclip/pull/5429) (2026-05-09)?**
> The new Secrets Manager temporarily disables plugin secret-ref UUIDs while a company-scoped `plugin_config` follow-up lands. Activation fails with `Plugin secret references are disabled until company-scoped plugin config lands`, and `POST /api/plugins/:id/config` returns HTTP 422 for configs containing secret-ref UUIDs (e.g. `telegramBotTokenRef`). This is intentional fail-closed mitigation (PAP-2394). Until the follow-up ships, pin to the last `paperclipai` release before #5429.

See [Troubleshooting](docs/troubleshooting.md) for the full background and workaround.

---

## Why this plugin

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)), this plugin goes well beyond push-only notifications:

| Capability | Push-only ([PR #407](https://github.com/paperclipai/paperclip/pull/407)) | This plugin |
|------------|:--:|:--|
| Push notifications | ✅ | ✅ |
| Receive messages | ❌ | ✅ |
| Bot commands | ❌ | `/status`, `/issues`, `/agents`, `/approve`, `/topics`, `/acp`, `/commands` |
| Inline buttons | ❌ | Approve/reject on approvals, escalations, handoffs |
| Reply routing | ❌ | Replies become issue comments |
| Forum topic routing | ❌ | Topic = project |
| Daily digest | ❌ | ✅ |
| HITL escalation | ❌ | Dedicated channel with suggested replies + timeout |
| Multi-agent threads | ❌ | Up to 5 agents, `@mention` routing, handoff, discuss |
| Media pipeline | ❌ | Voice transcription, Brief Agent intake |
| Custom commands | ❌ | Importable multi-step workflows |
| Proactive suggestions | ❌ | Watch conditions with built-in templates |
| Packaging | Monorepo example | Standalone npm package |

It's the plugin Paperclip users asked for the day the plugin system shipped — *"let me know when it's done"* — and a whole lot more.

---

## Contributing

Issues and pull requests are welcome.

```bash
pnpm install      # install dependencies
pnpm typecheck    # type-check
pnpm test         # ~80 tests across notifications, approvals, escalation, media, and commands
pnpm build        # compile
```

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

---

## Credits

- [@MatB57](https://github.com/MatB57) — escalation channel concept, the "Chat OS" vision for bidirectional agent command centers, and the HITL suggested-reply flow.
- [@leeknowsai](https://github.com/leeknowsai) — worker bootstrap patterns adapted from the Discord plugin.
- Inspired by [OpenClaw's Telegram integration](https://github.com/openclaw/openclaw) (grammY, bidirectional messaging, inline buttons), adapted for the Paperclip plugin SDK.

---

## License

[MIT](LICENSE)
