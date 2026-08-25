# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`/status` and every daily digest structurally reported "Active agents: 0/N" (ODIAA-1606).**
  Both the `/status` command and the daily/bidaily/tridaily digest counted agents with
  `status === "active"`, but agents report `running`/`idle` (and `paused`/`error` when
  unavailable) — `active` is a valid value in the SDK union but is not emitted by current
  hosts. The filter matched nothing, so the count read zero regardless of activity: a wrong
  readout that looks authoritative. Counting now goes through a shared `src/agent-status.ts`
  predicate that decides availability with a *positive* filter over the statuses that mean an
  agent can take work (`idle`/`running`/`active`), which also fails safe — `terminated` and
  `pending_approval` are no longer miscounted as available, and a status added to the union
  later reads as unavailable rather than silently inflating the count. `/status` now reports
  `running` and `available` separately and flags `paused/error` only when present; the digest's
  never-seen "Top performer" line is relabelled "Working" since the agent list is unranked.
  Ported from upstream mvanhorn PR #87 (commits `bd3b2c5`, `657a8c3`, `79e322e`).

## [0.4.1] — 2026-08-12

Follow-up to the 0.4.0 company-scoped config work: the settings page itself was still
calling the host config endpoints unscoped.

### Fixed

- **Settings page sections failed with `"companyId" is required and must be a non-empty
  string` (ODIAA-1379).** Paperclip made plugin configuration company-scoped, and the host
  now runs both config routes through `requirePluginConfigCompanyId()`:
  `GET /api/plugins/:pluginId/config` reads `companyId` from the query string and
  `POST .../config` reads it from the request body. The settings page sent neither, so the
  host answered HTTP 400 and every section that loads config — Notification routing,
  Connection, Bot access, Media intake, Human escalation, Proactive suggestions, and Board
  fallback — rendered the raw host error instead of its settings. All reads and writes are
  now company-scoped, matching the host's own `pluginsApi.getConfig`/`saveConfig` client.

  0.4.0 fixed the *worker* side of this migration (config arrives via `onConfigChanged`
  instead of `ctx.config.get()`); this release fixes the *settings UI* side.

### Added

- New `src/plugin-config-scope.ts` builds the company-scoped config path and save body in
  one place, and fails fast with an operator-facing message ("Open this plugin's settings
  from inside a company…") instead of round-tripping to the host for its raw field-level
  400. Covered by `tests/plugin-config-scope.test.ts` (25 tests).

### Changed

- The seven settings sections now re-load when the selected company changes, rather than
  loading once on mount.

## [0.4.0] — 2026-08-09

Decision-interface release. Paperclip interactions (`request_confirmation`,
`ask_user_questions`) now travel end to end over Telegram, addressed to the board user
who actually owns the decision, and the plugin activates again on current Paperclip hosts.

### Added

- **Interaction cards in Telegram (TWX-46 / TWX-105 / TWX-328).** `issue.interaction.created`
  is now handled: the plugin renders a decision card and posts it to the routed chat, and
  answers flow back to the board.
  - New `src/interactions-api.ts` client fetches and responds to interactions, wrapping API
    failures in a structured `PaperclipApiError` (status + detail).
  - Inline **Accept / Reject** buttons resolve `request_confirmation` interactions; native
    replies to a card resolve it as free text.
  - `ask_user_questions` answers are parsed from `question_id=option_id` reply lines (TWX-105).
  - Stale callbacks fail gracefully: a 409 *already resolved* response is detected and
    reported in-chat instead of surfacing as a generic error (TWX-328).
  - Delivery reuses the ODIAA-698 idempotency guard, so a redelivered event does not
    post a duplicate card.

- **User-scoped decision routing (ODIAA-938 / TWX-517, TWX-525).** A decision card addressed
  to a specific board user is delivered to *that user's* chat instead of the shared
  approvals chat.
  - New config: `userChatMappings` (board `userId` → Telegram `chatId`) and
    `telegramActorMappings` (numeric Telegram `from.id` → board `userId`).
  - Authorization is keyed **strictly on the immutable numeric `from.id`**; usernames and
    display names never drive ownership, so an `@handle` reclaim cannot hijack a decision.
  - Deny by default: an unmapped actor, an owner-less resolution, or an actor/owner mismatch
    all reject the action before any board API call, on both the callback and reply paths.
  - An owned decision whose owner has no chat mapping produces a **non-actionable admin
    setup notice** rather than broadcasting an actionable card (fail closed).
  - Hardened per the ODIAA-942 security review; pure authorization logic lives in
    `src/decision-routing.ts` and is covered by regression tests.

- **Owner resolution fallback chain for targeted decisions (ODIAA-937 / TWX-940).** A card
  addressed to a specific user could previously be broadcast to the shared chat whenever the
  host event omitted `targetUserId` (older hosts, or interactions emitted before the issue was
  owned) — a confidentiality and correctness bug. Owner resolution now falls through in
  descending authority: host event payload → interaction record `targetUserId` /
  `assigneeUserId` → nested interaction payload → issue `assigneeUserId`. The resolved source
  is logged as evidence, and a genuinely targeted decision with no chat mapping still fails
  closed through the setup-notice path.

- **Cloudflare Access support for board API calls (ODIAA-732).** When the Paperclip
  board is fronted by Cloudflare Access, approval buttons and `/approve` no longer fail
  silently:
  - `cfAccessClientIdRef` / `cfAccessClientSecretRef` config knobs attach a Cloudflare
    Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) to plugin →
    board API calls. Both are sourced from secret-refs and are only sent when both
    resolve; values are never logged. (Fix A)
  - A non-blocking settings warning steers `paperclipBaseUrl` toward an **internal**
    address that bypasses Access, keeping the public hostname in `paperclipPublicUrl`
    for human deep-links. (Fix B)
  - New [`docs/cloudflare-access.md`](docs/cloudflare-access.md) guide: the two network
    legs, minting a service token, the three config knobs, the internal-URL
    recommendation, and the `url:` deep-link button caveat. README section, docs index,
    configuration reference, and troubleshooting entries added/updated. (Fix C)

### Fixed

- **Plugin could not be activated on Paperclip >= 2026.707.0 (ODIAA-1379).** Activation
  failed with

  ```
  Plugin "<id>" is not allowed to perform "config.get": company context is required
  ```

  Paperclip made plugin configuration company-scoped: `config.get` now only resolves
  inside a company-scoped invocation (action / tool / event / job). `setup()` runs inside
  the `initialize` RPC, before any invocation exists, so the `await ctx.config.get()` at
  the top of `setup()` was denied and worker initialize — and with it the whole
  activation — failed. The host instead replays each configured company's stored config
  through `configChanged` immediately after the worker starts.

  - `setup()` no longer reads configuration. The worker starts on `DEFAULT_CONFIG` and
    adopts the operator's settings when the host delivers them.
  - New `onConfigChanged` hook applies a delivered config in place: notification flags,
    chat/topic routing, base URLs, digest mode, and the legacy secret-ref bot token are
    all recomputed live.
  - Every event subscription, the daily-digest job, and the inbound polling loop now
    register **unconditionally** and re-check their `notifyOn*` / `enableCommands` /
    `enableInbound` / `digestMode` flag at delivery time. Gating registration on config
    would have disabled those handlers permanently, because registration happens before
    any config exists and the SDK only accepts registrations made synchronously inside
    `setup()`.
  - Delivered config is merged over `DEFAULT_CONFIG`, so keys an operator never saved
    keep their documented defaults instead of reading `undefined`.

- **Telegram `chatId` is no longer used as a company id (ODIAA-1178, cross-tenant).** All
  three resolvers (`worker.ts`, `commands.ts`, `acp-bridge.ts`) fell back to returning the
  raw numeric chat id when a chat had no company mapping, feeding a bogus company "UUID"
  into board API calls — the root cause of the BEL-183 spam loop and a cross-tenant
  misrouting risk. `resolveCompanyId` now throws a friendly *not linked, use `/connect`*
  error, which the company-scoped command handlers already answer with linking guidance.
  Also closes the remaining fallbacks reachable from the worker path
  (`tryCustomCommand` / `handleCommandsCommand` and their sub-handlers in
  `command-registry.ts`, and `/acp spawn|cancel|close`).
  Upstream: mvanhorn/paperclip-plugin-telegram `48eeafc`.

- **One unlinked chat could wedge polling for every chat (ODIAA-1178, availability).** The
  polling offset is deliberately held when `handleUpdate` throws, so a throw escaping it
  re-fetched and re-threw the same update forever. A non-throwing
  `resolveCompanyIdOrNull` now backs the three `handleUpdate` call sites: commands get a
  friendly reply, media and thread routing skip with a debug log, and the offset advances.
  Upstream: mvanhorn/paperclip-plugin-telegram `5f65627`.

- **Misleading `ok` health when secret resolution is disabled (ODIAA-935).** Bot-token
  startup resolution goes through a new `resolveStartupTelegramBotToken()` helper. When
  `ctx.secrets.resolve` throws — the plugin secret-ref kill switch is active, or
  company-scoped config has not landed yet — the worker records an operator-facing
  *degraded* runtime health diagnostic, logs the error, and goes idle instead of reporting
  `ok`. `resolveBotToken()` prefers the live instance-state connection and clears a stale
  degraded signal when it succeeds.
  Upstream: mvanhorn/paperclip-plugin-telegram `8a0e579`.

### Changed

- **A config save no longer restarts the worker.** Implementing `onConfigChanged` opts
  the plugin out of the host's restart-on-config-change default; settings now take effect
  inside the running worker (inbound polling picks up `enableCommands` / `enableInbound`
  changes within ~2s). The plugin stays deliberately single-tenant — the bot connection is
  instance-wide and chats map to companies at runtime — so the host's fail-closed
  `CROSS_TENANT_CONFIG` guard still applies if two companies are configured with
  different settings.
- **`@paperclipai/plugin-sdk` and `@paperclipai/shared` dev dependencies bumped to
  `^2026.722.0`** (from `^2026.318.0`) to match the current host and SDK. The
  `onConfigChanged` company-scope argument is typed as optional so the plugin builds
  against both the current SDK — which passes the config alone — and newer hosts that
  thread the company scope through.

### Notes

- **`url:` deep-link buttons behind Access:** buttons such as *Open `<issue>` ↗* and
  *View Run ↗* open the public UI and require an authenticated browser session; a service
  token does not authorize them. Rely on in-chat `callback_data` actions, add a Cloudflare
  Access bypass policy for read-only deep links, or suppress `url:` buttons. See the
  [caveat](docs/cloudflare-access.md#caveat-url-deep-link-buttons-behind-access).

- **Inbound reply org-routing is now regression-tested (ODIAA-936).** The routing logic was
  extracted from `handleUpdate` into an exported `routeInboundReply()` helper, with a test
  asserting replies are delivered to the *originating* org via the `companyId` persisted on
  the outbound message mapping — never re-derived from the chat-level company. No behavior
  change; this locks in, in our architecture's terms, the guarantee upstream tue-Jonas
  TWX-893 achieves differently (their `chatCompanyMap` + `defaultCompanyId` inbox-wake path
  is not portable here).

- **Server-side ownership enforcement is still a follow-up (ODIAA-942, Finding 1).** For the
  interaction path, the `from.id` allowlist described above is the only ownership control
  today: the plugin's board token is company-scoped and carries no acting identity, so the
  board cannot yet verify *which* user pressed a button.

- **Decision routing requires mapping configuration.** `userChatMappings` and
  `telegramActorMappings` are empty by default; until an operator populates them, targeted
  decisions produce the admin setup notice rather than an actionable card. That is intended
  fail-closed behavior, not a regression.

## [0.3.1]

- Inbound commands work after an instance-wide `/connect` (ODIAA-720): the bot is activated
  in-process instead of waiting for a worker restart.

## [0.3.0]

- Instance-wide Telegram bot token storage (ODIAA-726).
- README rewrite and structured `docs/` guide set.
- Fork-integration features from ant013 and tue-Jonas (ODIAA-682).
- Package rebrand and npm publish workflow guard (ODIAA-689).
