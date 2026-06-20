# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
