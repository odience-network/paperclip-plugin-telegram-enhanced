# Workflow Commands

Build your own `/slash` commands by importing multi-step workflows. Each workflow runs a sequence of steps — fetch an issue, invoke an agent, call an API, post a message — and can be triggered like any built-in command.

## Managing commands

| Command | Description |
|---------|-------------|
| `/commands import <json>` | Import a multi-step workflow as a custom slash command. |
| `/commands list` | List all registered workflow commands. |
| `/commands run <name> [args]` | Execute a workflow command. |
| `/commands delete <name>` | Remove a workflow command. |

Imported commands are stored in a **per-company** registry and can be invoked directly as `/<name>`. Custom commands **cannot override** built-in commands.

## Step types

A workflow is a list of steps. Each step has a type:

| Step type | What it does |
|-----------|--------------|
| `fetch_issue` | Load a Paperclip issue. |
| `invoke_agent` | Call a Paperclip agent. |
| `http_request` | Make an outbound HTTP request. |
| `send_message` | Send a Telegram message. |
| `create_issue` | Create a Paperclip issue. |
| `wait_approval` | Pause until an approval resolves. |
| `set_state` | Store a value in plugin state for later steps. |

## Template interpolation

Steps can reference arguments and the output of previous steps using `{{...}}` placeholders:

| Placeholder | Resolves to |
|-------------|-------------|
| `{{arg0}}`, `{{arg1}}`, … | Positional arguments passed to the command. |
| `{{args}}` | All arguments. |
| `{{prev.result}}` | The result of the previous step. |
| `{{step_id.result}}` | The result of a specific named step. |

## Example

A minimal workflow that fetches an issue and posts its title back to the chat:

```json
{
  "name": "summarize",
  "steps": [
    { "id": "issue", "type": "fetch_issue", "issueId": "{{arg0}}" },
    { "type": "send_message", "text": "Issue: {{issue.result.title}}" }
  ]
}
```

Import and run it:

```text
/commands import {"name":"summarize","steps":[ ... ]}
/commands run summarize ODIAA-123
```

---

← Back to [Documentation](README.md) · Next: [Troubleshooting](troubleshooting.md)
