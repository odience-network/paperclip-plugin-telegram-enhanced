# Notifications & Routing

How the plugin decides *what* to send and *where* to send it. All messages are formatted in Telegram **MarkdownV2** with an automatic plain-text fallback if formatting fails.

## Notification types

| Type | Contents |
|------|----------|
| **Issue created** | Title, description, status, priority, assignee, project fields, and a **View Issue** link. |
| **Issue done** | Completion confirmation with status fields. |
| **Approval requested** | Interactive **Approve** and **Reject** inline buttons — act without leaving Telegram. |
| **Agent error** | Error message with a warning indicator. |
| **Agent run started / finished** | Lifecycle notifications (off by default). |

Toggle each type with the `notifyOn*` settings in the [Configuration Reference](configuration.md#notification-toggles).

## Interactive approvals

Every approval notification includes inline **Approve** / **Reject** buttons:

- Tapping a button calls the Paperclip API and updates the Telegram message in place.
- The callback query is acknowledged with a result message.

> Approval actions require board access on authenticated deployments. See [Getting Started → board access](getting-started.md#6-enable-approval-buttons-board-access).

Set `onlyNotifyBoardApprovals: true` to receive approval notifications **only** for `request_board_approval` approvals, keeping internal CEO approvals inside Paperclip.

## Per-type chat routing

Send each kind of notification to a different chat instead of one firehose:

| Setting | Routes |
|---------|--------|
| `approvalsChatId` | Approval notifications |
| `errorsChatId` | Agent errors |
| `digestChatId` | Digest summaries |
| `escalationChatId` | Agent escalations |

Anything not explicitly routed falls back to `defaultChatId`. You can also override routing per company via the `/connect` command.

## Forum topic routing

In Telegram groups with **forum topics** enabled, you can route notifications into specific topics.

### Per-type topics

| Setting | Routes into topic |
|---------|-------------------|
| `approvalsTopicId` | Approval notifications |
| `errorsTopicId` | Agent error notifications |
| `digestTopicId` | Daily/bidaily/tridaily digests |

If a topic ID is empty, the plugin keeps its existing behavior. Digest messages in forum groups fall back to the **General** topic.

### Topic = project

Map a forum topic to a Paperclip **project** so all of that project's notifications land in its own topic:

```text
/connect_topic <project-name> [topic-id]   Map a topic to a project
/topics list                               Show current mappings
/topics remove <project-name>              Remove one mapping
/topics clear                              Remove all mappings
```

Enable this with `topicRouting: true`. Requires a group with forum topics enabled. See [Bot Commands](commands.md) for full command syntax.

## Reply routing (inbound)

When `enableInbound` is on (default), replying to a bot notification routes your message back into Paperclip:

- Replies to **issue** notifications create issue comments automatically.
- Replies to **escalation** notifications resolve the escalation as a human reply.

Lock this down with the [security allowlists](getting-started.md#7-secure-inbound-interactions).

## Daily digest

Get a rolled-up summary instead of (or alongside) live notifications:

| `digestMode` | Frequency |
|--------------|-----------|
| `off` | Disabled (default). |
| `daily` | Once per day at `dailyDigestTime`. |
| `bidaily` | Twice per day (`dailyDigestTime` + `bidailySecondTime`). |
| `tridaily` | Three times per day at `tridailyTimes`. |

Each digest includes tasks completed and created, active agents, and in-progress / in-review / blocked issues. Times are UTC (HH:MM). See the [Configuration Reference](configuration.md#daily-digest).

---

← Back to [Documentation](README.md) · Next: [Bot Commands](commands.md)
