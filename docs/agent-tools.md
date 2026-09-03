# Agent Tools

The plugin gives your Paperclip agents tools to escalate to humans, collaborate in shared threads, and proactively surface suggestions — all through Telegram.

## Tool summary

| Tool | Description |
|------|-------------|
| `escalate_to_human` | Escalate a conversation to a human when confidence is low. |
| `handoff_to_agent` | Hand off work to another agent in the thread. |
| `discuss_with_agent` | Start a back-and-forth conversation with another agent. |
| `register_watch` | Register a proactive watch that monitors entities and sends suggestions. |
| `send_to_telegram` | Send text or a Markdown document to a chat, with optional project-key file routing (`send_file_to_telegram` is a deprecated alias). |

---

## Making the tools callable from an agent run

Declaring a tool in the manifest is not enough for an agent to reach it. Two separate host mechanisms have to line up.

### 1. Registration (automatic)

Paperclip reads `manifest.tools` when the plugin reaches `ready` and registers each entry with the plugin tool dispatcher under its **namespaced name**:

```
paperclip-plugin-telegram-enhanced:send_to_telegram
paperclip-plugin-telegram-enhanced:send_file_to_telegram
paperclip-plugin-telegram-enhanced:escalate_to_human
paperclip-plugin-telegram-enhanced:handoff_to_agent
paperclip-plugin-telegram-enhanced:discuss_with_agent
paperclip-plugin-telegram-enhanced:register_watch
```

The worker's `ctx.tools.register(...)` handlers (which need the `agent.tools.register` capability) supply the implementations that the dispatcher routes to. Nothing else is required from the plugin.

### 2. Tool-access policy (operator setup, required)

Agents reach the tools over the control-plane API — `GET /api/plugins/tools` to discover and `POST /api/plugins/tools/execute` to invoke — and **both go through the Tool Gateway's access policy**. The policy's default is deny: if no tool profile, explicit grant, or allow policy covers a tool, discovery silently omits it and execution fails with `403 deny_default`.

The symptom of a missing profile is that `GET /api/plugins/tools` returns `[]` even though the plugin is `ready` and the manifest declares tools.

A board user (this is not agent-writable) enables them once per company, either in **Tools → Access → Profiles** in the dashboard or via the API:

```bash
# 1. Create a profile that allows exactly the plugin's tools.
curl -X POST "$API/api/companies/$COMPANY_ID/tools/profiles" \
  -H 'Content-Type: application/json' \
  -d '{
        "profileKey": "telegram-plugin-agent-tools",
        "name": "Telegram Plugin Agent Tools",
        "status": "active",
        "defaultAction": "deny",
        "entries": [
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:send_to_telegram" },
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:send_file_to_telegram" },
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:escalate_to_human" },
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:handoff_to_agent" },
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:discuss_with_agent" },
          { "selectorType": "tool_name", "effect": "include", "toolName": "paperclip-plugin-telegram-enhanced:register_watch" }
        ]
      }'

# 2. Bind it. targetType "company" covers every agent; use "agent" with an
#    agent id to enable one agent at a time.
curl -X POST "$API/api/companies/$COMPANY_ID/tools/profiles/$PROFILE_ID/bind" \
  -H 'Content-Type: application/json' \
  -d '{ "targetType": "company", "targetId": "'"$COMPANY_ID"'", "priority": 100 }'
```

`defaultAction: "deny"` plus `tool_name` includes keeps the profile scoped to these six tools; it does not widen access to any other plugin or MCP tool.

#### Use `tool_name` entries, not `application` entries

Paperclip backfills every installed plugin into the tool **applications** list, so the profile wizard offers `paperclip-plugin-telegram-enhanced` as a selectable application. Selecting it looks correct and saves without error, but it never grants anything: an `application` entry matches on `entry.applicationId === ctx.applicationId`, and the policy only resolves `ctx.applicationId` from a catalog entry or a tool connection. Plugin tools have neither — their descriptors carry `name`, `displayName`, `description`, `parametersSchema` and `pluginId`, but no application id — so `ctx.applicationId` stays `null` and the entry can never match.

A profile whose only entry is the plugin application therefore still denies with `deny_default`, and `GET /api/plugins/tools` still returns `[]`, which is indistinguishable from having created no profile at all. Select **Tool name** as the selector type and add the six namespaced names above.

### 3. Calling convention

```bash
curl -X POST "$API/api/plugins/tools/execute" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "tool": "paperclip-plugin-telegram-enhanced:send_to_telegram",
        "parameters": { "text": "hello", "chatId": "-100...", "threadId": 42 },
        "runContext": {
          "agentId": "'"$PAPERCLIP_AGENT_ID"'",
          "runId": "'"$PAPERCLIP_RUN_ID"'",
          "companyId": "'"$PAPERCLIP_COMPANY_ID"'",
          "projectId": "<the project of the issue this run is checked out on>"
        }
      }'
```

`runContext.projectId` is mandatory and is cross-checked against the run's issue. Passing a project that differs from the checked-out issue's project — including passing any project when **the issue has no project at all** — is rejected as `deny_run_context_mismatch`. Give the issue a project before calling these tools from a heartbeat.

---

## Human-in-the-loop escalation

When an agent is stuck — low confidence, an explicit user request, a policy violation, or unknown intent — it calls `escalate_to_human`. The plugin then:

- Posts the escalation to a dedicated channel (`escalationChatId`) with the **conversation context**, a **suggested reply**, and a **confidence score**.
- Adds inline buttons: **Send Suggested Reply**, **Reply**, **Override**, **Dismiss**.
- Sends a configurable **hold message** to the customer while waiting (`escalationHoldMessage`).
- Routes the human's reply back to the originating chat via native or ACP transport.

If no human responds within `escalationTimeoutMs` (default 15 min), the configured `escalationDefaultAction` fires:

| Action | Behavior |
|--------|----------|
| `defer` | Leave the escalation open (default). |
| `auto_reply` | Send the suggested reply automatically. |
| `close` | Close the escalation. |

See the [escalation settings](configuration.md#human-in-the-loop-escalation).

---

## Multi-agent group threads

Run several agents in one Telegram thread (up to `maxAgentsPerThread`, default 5).

### Routing

- **`@mention`** — address a specific agent by name in the thread.
- **Reply-to** — reply to an agent's message to route your message to that agent.
- **Fallback** — unaddressed messages go to the most recently active agent.

### Collaboration tools

- **Handoff** — an agent calls `handoff_to_agent` to transfer work, optionally behind a human approval gate.
- **Discuss** — an agent calls `discuss_with_agent` to start a back-and-forth loop with another agent.

Conversation loops support a configurable max number of turns and human checkpoint pauses. The plugin detects **stale loops** (auto-pausing when output repeats) and **sequences output** so multi-agent responses don't interleave.

Agents are spawned **native-first** (Paperclip agent sessions) with an ACP fallback, and are auto-spawned on handoff/discuss if the target agent isn't already in the thread.

---

## Media-to-task pipeline

Send media into a thread or intake channel and the plugin routes it to agents:

- **Supported media:** voice messages, audio, video notes, documents, and photos.
- **Transcription:** voice and audio are transcribed via the Whisper API (`transcriptionApiKeyRef`), with a transcription preview posted back.
- **Brief Agent:** media sent to configured intake channels (`briefAgentChatIds`) is forwarded to a configurable **Brief Agent** (`briefAgentId`) for triage.
- Media in an active agent thread is routed to that session (native or ACP).

See the [media pipeline settings](configuration.md#media-pipeline).

---

## Proactive suggestions (watches)

Agents call `register_watch` to set up condition-based monitors that fire suggestions when something needs attention.

- **Operators:** `gt`, `lt`, `eq`, `ne`, `contains`, `exists`.
- **Targets:** fields on issues, agents, or custom state-stored data.
- **Built-in templates:** `invoice-overdue`, `lead-stale`.
- **Custom templates:** use `{{field}}` placeholder interpolation.
- **Rate limiting:** `maxSuggestionsPerHourPerCompany` (default 10) caps suggestion volume.
- **Deduplication:** the same watch + entity won't re-fire within `watchDeduplicationWindowMs` (default 24h).

A scheduled job evaluates all registered watches periodically. See the [proactive-suggestion settings](configuration.md#proactive-suggestions).

---

## Agent file send & project-key routing

The `send_to_telegram` tool lets an agent deliver content to Telegram (`send_file_to_telegram` is a deprecated alias):

- **Text** — pass `text` to send a plain/Markdown message via `sendMessage`.
- **Markdown document** — pass `markdownContent` (optionally `markdownFileName`, default `paperclip-message.md`) to upload a `.md` file via `sendDocument`. If Paperclip's HTTP bridge drops the multipart body, the upload retries with native `fetch` so Telegram still receives the file.

Only `text` and `markdownContent` are accepted as content sources — file paths, URLs, and raw `file_id`s are rejected, and filenames are validated as safe `.md` basenames.

### Routing by project key

Document sends can be routed **by project key** instead of an explicit `chatId`:

- Provide one of `projectKey` (e.g. `TEL`), `issueIdentifier` (e.g. `TEL-8`), or `issueId` (resolved to its identifier via the board API). Explicit `chatId` / `threadId` may **not** be combined with route inputs.
- The matching enabled `fileRoutes` entry supplies the destination chat and topic. No match, an ambiguous match, or invalid route config returns a structured error.

Configure destinations with the [`fileRoutes`](configuration.md#agent-file-routing) config array.

---

← Back to [Documentation](README.md) · Next: [Workflow Commands](workflow-commands.md)
