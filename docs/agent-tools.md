# Agent Tools

The plugin gives your Paperclip agents tools to escalate to humans, collaborate in shared threads, and proactively surface suggestions — all through Telegram.

## Tool summary

| Tool | Description |
|------|-------------|
| `escalate_to_human` | Escalate a conversation to a human when confidence is low. |
| `handoff_to_agent` | Hand off work to another agent in the thread. |
| `discuss_with_agent` | Start a back-and-forth conversation with another agent. |
| `register_watch` | Register a proactive watch that monitors entities and sends suggestions. |

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

← Back to [Documentation](README.md) · Next: [Workflow Commands](workflow-commands.md)
