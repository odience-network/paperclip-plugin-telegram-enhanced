# Bot Commands

Commands you can send to the bot from any allowed chat. Enable them with `enableCommands` (default: `true`), and restrict who can run them with the [security allowlists](getting-started.md#7-secure-inbound-interactions).

## Status & inspection

| Command | Description |
|---------|-------------|
| `/status` | Show active agents and recent completions. |
| `/issues` | List open issues. |
| `/agents` | List agents with status indicators. |
| `/help` | Display all available commands. |

## Approvals

| Command | Description |
|---------|-------------|
| `/approve <id>` | Approve a pending approval by ID. |

> Tip: most of the time you'll just tap the inline **Approve** button on the notification. `/approve` is handy when you know the ID. Requires [board access](getting-started.md#6-enable-approval-buttons-board-access).

## Linking chats & topics

| Command | Description |
|---------|-------------|
| `/connect <company>` | Link this chat to a Paperclip company. |
| `/connect_topic <project-name> [topic-id]` | Map a forum topic to an existing Paperclip project. |
| `/topics list` | Show forum topic mappings for this chat. |
| `/topics remove <project-name>` | Remove one forum topic mapping. |
| `/topics clear` | Remove all forum topic mappings for this chat. |

See [Notifications & Routing](notifications.md#forum-topic-routing) for how topic routing works.

## Agent sessions (ACP)

Run agent sessions directly inside a Telegram thread:

| Command | Description |
|---------|-------------|
| `/acp spawn <agent>` | Start a new agent session in the current thread. |
| `/acp status` | Check ACP session status. |
| `/acp cancel` | Cancel a running ACP session. |
| `/acp close` | Close a completed ACP session. |

For multi-agent threads, `@mention` routing, handoff, and discuss, see [Agent Tools](agent-tools.md).

## Custom workflow commands

| Command | Description |
|---------|-------------|
| `/commands import <json>` | Import a multi-step workflow as a custom slash command. |
| `/commands list` | List registered workflow commands. |
| `/commands run <name> [args]` | Execute a workflow command. |
| `/commands delete <name>` | Delete a workflow command. |

Imported commands are also invocable directly as `/<name>` (they cannot override built-ins). Full guide: [Workflow Commands](workflow-commands.md).

---

← Back to [Documentation](README.md) · Next: [Agent Tools](agent-tools.md)
