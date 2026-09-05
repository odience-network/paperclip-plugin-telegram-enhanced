# Configuration Reference

Every plugin setting, its default, and what it controls. Only `telegramBotTokenRef` is required — everything else is optional and has a sensible default.

> Set these in the Telegram plugin settings page or via the plugin config API. After changing values, save and (if needed) restart the plugin.

## Configuration scope

Plugin configuration is stored **per company**, and the worker keeps it that
way: every notification toggle, filter, and chat/topic route is read from the
config of the company the notification is about, and `/status` reports that
same company's flags. A company whose config has never been saved runs on the
defaults below — never on another company's settings.

Three values describe the instance rather than a company, because there is one
bot connection and one board behind it: the bot token (Bot Connection, or the
legacy `telegramBotTokenRef`), `paperclipBaseUrl`, and `paperclipPublicUrl`.
Set them once. If several companies have saved configs, a company that leaves
one of these at its default will not overwrite a value another company set.

## Core

| Setting | Required | Default | Description |
|---------|:--:|---------|-------------|
| Bot token (Bot Connection) | ✅ | — | Connect the bot instance-wide via **Settings → Bot Connection**. Stored server-side; not a config field. See [Getting Started](getting-started.md#4-connect-your-bot-instance-wide). |
| `telegramBotTokenRef` | | — | **Optional / legacy.** Secret **UUID** fallback for the bot token. Prefer Bot Connection (secret-refs are company-scoped and disabled on recent master, post-#5429). |
| `defaultChatId` | | — | Fallback chat ID for notifications when no per-type chat is set. |
| `paperclipBaseUrl` | | `http://localhost:3100` | **Internal** Paperclip API URL the worker calls directly. Keep it on an address that bypasses Cloudflare Access (loopback/private). See [Cloudflare Access](cloudflare-access.md). |
| `paperclipPublicUrl` | | — | **Public** URL used for issue/agent/run deep-links in messages. This is the Access-protected hostname for human browsers. |
| `enableCommands` | | `true` | Enable bot commands. |
| `enableInbound` | | `true` | Route Telegram replies back to Paperclip as issue comments / escalation replies. |

## Notification routing

Route each notification type to its own chat or forum topic. Anything left unset falls back to `defaultChatId`. See [Notifications & Routing](notifications.md) for behavior.

| Setting | Default | Description |
|---------|---------|-------------|
| `approvalsChatId` | — | Dedicated chat for approval notifications. |
| `approvalsTopicId` | — | Forum topic ID for approvals inside the approvals/default chat. |
| `errorsChatId` | — | Dedicated chat for agent errors. |
| `errorsTopicId` | — | Forum topic ID for errors inside the errors/default chat. |
| `digestChatId` | — | Dedicated chat for digest notifications. |
| `digestTopicId` | — | Forum topic ID for digests inside the digest/default chat. |
| `escalationChatId` | — | Dedicated chat for agent escalations. |
| `onlyNotifyBoardApprovals` | `false` | Send approval notifications only for `request_board_approval` approvals, keeping internal CEO approvals inside Paperclip. |

### Notification toggles

| Setting | Default | Description |
|---------|---------|-------------|
| `notifyOnIssueCreated` | `true` | Notify when an issue is created. |
| `notifyOnIssueDone` | `true` | Notify when an issue is completed. |
| `notifyOnIssueBlocked` | `false` | Notify when an issue becomes blocked **and** is owned by a human/board user (`assigneeUserId` set). Agent-only blocks are suppressed. |
| `notifyOnIssueAssigned` | `false` | Notify when an issue is assigned. |
| `onlyNotifyIfAssignedTo` | — | Restrict issue notifications to a specific assignee. |
| `notifyOnBoardMention` | `false` | Notify when an issue comment `@`-mentions a configured board username. Requires `boardUsernames`. |
| `boardUsernames` | — | Comma/space-separated board handles (with or without `@`), matched case-insensitively and word-boundary aware by `notifyOnBoardMention`. |
| `notifyOnApprovalCreated` | `true` | Notify when an approval is requested. |
| `notifyOnAgentError` | `true` | Notify on agent errors. |
| `notifyOnAgentRunStarted` | `false` | Notify when an agent run starts (high-frequency on busy instances). |
| `notifyOnAgentRunFinished` | `false` | Notify when an agent run finishes (high-frequency on busy instances). |

## Daily digest

| Setting | Default | Description |
|---------|---------|-------------|
| `digestMode` | `off` | Digest frequency: `off`, `daily`, `bidaily`, or `tridaily`. |
| `dailyDigestTime` | `09:00` | UTC time (HH:MM) for the daily digest. |
| `bidailySecondTime` | `17:00` | Second digest time for `bidaily` mode. |
| `tridailyTimes` | `07:00,13:00,19:00` | Comma-separated HH:MM times for `tridaily` mode. |

## Forum topic routing

| Setting | Default | Description |
|---------|---------|-------------|
| `topicRouting` | `false` | Map Telegram forum topics to Paperclip projects. Requires a group with forum topics enabled. |

## Security allowlists

| Setting | Default | Description |
|---------|---------|-------------|
| `allowedTelegramUserIds` | `[]` (any) | Telegram user IDs allowed to use commands, replies, media intake, and inline buttons. |
| `allowedTelegramChatIds` | `[]` (any) | Telegram chat IDs where those interactions are accepted. |

> If both allowlists are set, **both must match**. See [Getting Started](getting-started.md#7-secure-inbound-interactions).

## Inbound replies and who they are posted as

Replying to a notification card posts your message as a comment on the task it came
from. The plugin posts it **as you** whenever it can identify you — that is what makes
it a real comment (one the assigned agent is woken by, and that reopens a finished
task) instead of a system message nothing acts on.

| Setting | Default | Description |
|---------|---------|-------------|
| `telegramActorMappings` | `{}` | Stringified numeric Telegram `from.id` → Paperclip user ID, e.g. `{"134628202": "local-board"}`. The authoritative link, and the only one that grants decision (approve/reject) ownership. |
| `userChatMappings` | `{}` | Paperclip user ID → Telegram chat ID. Routes owner-targeted decision cards, and is read in reverse to identify the sender of a **private**-chat reply. |

With neither set, a company that has exactly one active human member attributes replies
to that member. Anything ambiguous (two humans, no mapping) is left unattributed, and the
sender is told once a day that their replies are not being attributed.

> Attribution decides **who a comment is from**. It never grants authority: approving or
> rejecting a decision card still requires an explicit `telegramActorMappings` entry, and
> the host re-verifies that the user is an active, non-viewer member of the company.

## Board access (approvals)

| Setting | Default | Description |
|---------|---------|-------------|
| `paperclipBoardApiTokenRef` | — | Advanced/manual secret reference to a Paperclip board API token used by approval buttons and `/approve`. Prefer the **Board Access Connection** settings UI when available. |
| `cfAccessClientIdRef` | — | Secret reference to a Cloudflare Access **service-token Client ID**. Sent as the `CF-Access-Client-Id` header on plugin → board calls so approvals/`/approve` work when the board is behind Cloudflare Access. Only used when both this and the secret ref are set. See [Cloudflare Access](cloudflare-access.md). |
| `cfAccessClientSecretRef` | — | Secret reference to a Cloudflare Access **service-token Client Secret**. Sent as the `CF-Access-Client-Secret` header. Leave both blank when the board is not behind Access. |

## Human-in-the-loop escalation

| Setting | Default | Description |
|---------|---------|-------------|
| `escalationTimeoutMs` | `900000` (15 min) | Timeout before the default action fires. |
| `escalationDefaultAction` | `defer` | Action on timeout: `defer`, `auto_reply`, or `close`. |
| `escalationHoldMessage` | `"Let me check on that - I'll get back to you shortly."` | Message sent to the customer while waiting for a human. |

## Multi-agent threads

| Setting | Default | Description |
|---------|---------|-------------|
| `maxAgentsPerThread` | `5` | Maximum concurrent agents per thread. |

## Media pipeline

| Setting | Default | Description |
|---------|---------|-------------|
| `briefAgentId` | — | Agent ID for the media-intake Brief Agent. |
| `briefAgentChatIds` | `[]` | Chat IDs that act as media-intake channels. |
| `transcriptionApiKeyRef` | — | Secret reference to an OpenAI API key for Whisper transcription. |

## Agent file routing

Used by the `send_to_telegram` agent tool to route Markdown documents by project key instead of an explicit chat ID. See [Agent Tools](agent-tools.md#agent-file-send--project-key-routing).

| Setting | Default | Description |
|---------|---------|-------------|
| `fileRoutes` | `[]` | Array of routing rules mapping a project key to a destination chat/topic. |

Each enabled `fileRoutes` entry is validated at config-save time and needs a unique `name`, an uppercase alphanumeric `projectKey` (unique across enabled routes), a numeric `chatId`, and an optional numeric `topicId`:

```json
"fileRoutes": [
  { "name": "Telegram squad", "enabled": true, "projectKey": "TEL", "chatId": "-1001234567890", "topicId": "42" }
]
```

## Proactive suggestions

| Setting | Default | Description |
|---------|---------|-------------|
| `maxSuggestionsPerHourPerCompany` | `10` | Rate limit for proactive suggestions. |
| `watchDeduplicationWindowMs` | `86400000` (24h) | Suppress duplicate watch suggestions within this window. |

---

← Back to [Documentation](README.md) · Next: [Notifications & Routing](notifications.md)
