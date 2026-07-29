# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Added

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

### Notes

- **`url:` deep-link buttons behind Access:** buttons such as *Open `<issue>` ↗* and
  *View Run ↗* open the public UI and require an authenticated browser session; a service
  token does not authorize them. Rely on in-chat `callback_data` actions, add a Cloudflare
  Access bypass policy for read-only deep links, or suppress `url:` buttons. See the
  [caveat](docs/cloudflare-access.md#caveat-url-deep-link-buttons-behind-access).

## [0.3.0]

- Instance-wide Telegram bot token storage (ODIAA-726).
- README rewrite and structured `docs/` guide set.
- Fork-integration features from ant013 and tue-Jonas (ODIAA-682).
- Package rebrand and npm publish workflow guard (ODIAA-689).
