# Cloudflare Access

If your Paperclip board is fronted by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), a bare `Authorization: Bearer <token>` request is intercepted with an interactive login challenge before it ever reaches the origin. Without extra configuration this makes the plugin's **Approve/Reject buttons** and the **`/approve`** command silently fail, and deep-link buttons land users on a login page instead of the issue.

This guide explains the two network legs involved, how to mint a Cloudflare Access **service token**, the three config knobs that make it work, and the caveat for `url:` deep-link buttons.

> **TL;DR**
> - Point `paperclipBaseUrl` at an **internal** address the worker reaches directly (e.g. `http://localhost:3100`). Keep the public Access-protected hostname in `paperclipPublicUrl` for human links.
> - If the worker can only reach Paperclip over the public hostname, mint a Cloudflare Access **service token** and set `cfAccessClientIdRef` + `cfAccessClientSecretRef`.
> - `url:` deep-link buttons always point at the public UI behind Access — they need an authenticated browser session. Prefer `callback_data` actions, add a bypass policy, or suppress the buttons.

---

## The two network legs

The plugin talks to Paperclip over two distinct legs, and only one of them is affected by Cloudflare Access in the same way:

| Leg | Who makes the request | URL used | Behind Access? |
|-----|-----------------------|----------|----------------|
| **Plugin → board API** | The worker (server-side), for approvals, comments, escalation replies. | `paperclipBaseUrl` | A bearer token alone is **rejected** with a login challenge. Needs a service token, or an internal URL that bypasses Access. |
| **Human → public UI** | The board user's **browser**, when they tap a deep-link (`url:`) button. | `paperclipPublicUrl` | Works **only** if the browser already has an authenticated Access session. |

The worker only bypasses Cloudflare Access automatically for **loopback** hosts (`localhost`, `127.0.0.1`, …) — for those, requests go direct to the origin and never cross Access. Any public/Access-protected hostname in `paperclipBaseUrl` returns a 302/403 login challenge, so approval buttons and `/approve` fail with no obvious error.

---

## Recommended setup: internal base URL

For **co-located deployments** (the plugin runs on the same host/network as the Paperclip board), the simplest and most secure option requires **no secrets at all**:

- Set `paperclipBaseUrl` to an address the worker reaches directly, bypassing Cloudflare Access:
  - `http://localhost:3100` (default) when the board runs on the same host.
  - An RFC1918 / private address (`http://10.x.x.x`, `http://192.168.x.x`, `http://172.16–31.x.x`), a link-local address, a unique-local IPv6 address, an internal DNS name (`*.internal`, `*.local`), or a single-label service host (e.g. a `docker-compose` service name like `paperclip`).
- Set `paperclipPublicUrl` to the **public**, Access-protected hostname so issue/agent/run links in Telegram messages resolve for humans.

The settings UI surfaces a non-blocking **warning** when `paperclipBaseUrl` resolves to a non-internal host (it matches loopback, RFC1918, link-local, unique-local, internal DNS suffixes, and single-label service names; anything else is treated as public). The warning is advisory, not a hard block — remote workers using a service token (below) legitimately keep a public base URL.

---

## Alternative: Cloudflare Access service token

If the worker **cannot** reach Paperclip over an internal address — for example a remote/cloud worker that can only talk to the board over its public, Access-protected hostname — use a Cloudflare Access **service token**. A service token is a non-interactive credential (a `Client-Id` / `Client-Secret` pair) that Access accepts in place of a browser login.

### 1. Mint a service token in Cloudflare

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), go to **Access → Service Auth → Service Tokens**.
2. Click **Create Service Token**, give it a descriptive name (e.g. `paperclip-telegram-plugin`), and choose a duration.
3. Copy the generated **Client ID** and **Client Secret** immediately — the secret is shown **only once**.

### 2. Allow the token through your Access application

Service tokens are not authorized by default. On the Access application that protects your Paperclip board:

1. Open **Access → Applications → _your Paperclip app_ → Policies**.
2. Add (or edit) a policy with action **Service Auth** and an **Include** rule of **Service Token** → _the token you created_ (or "Any Access Service Token").

Without this policy the token is minted but still rejected.

### 3. Store the pair as Paperclip secrets

Store the Client ID and Client Secret as Paperclip secrets and reference them by their secret UUIDs. **Never** paste the raw values into config fields.

### 4. Configure the plugin

Set both refs in the plugin settings (**Connection & URLs / Board Access** section) or via the config API:

| Config knob | Maps to outbound header | Notes |
|-------------|-------------------------|-------|
| `cfAccessClientIdRef` | `CF-Access-Client-Id` | Secret-ref UUID for the service token's Client ID. |
| `cfAccessClientSecretRef` | `CF-Access-Client-Secret` | Secret-ref UUID for the service token's Client Secret. |

Both are **optional**, but Cloudflare Access ignores a half-configured pair, so the plugin only attaches the headers when **both** resolve to non-empty values. Leave both blank when the board is not behind Access. The resolved values are sent only on plugin → board API calls (approval buttons, `/approve`) and are **never logged or echoed**.

> The `paperclipBaseUrl` warning is advisory precisely so this setup keeps working: a remote worker with a valid service token should keep `paperclipBaseUrl` pointed at the public hostname and dismiss the warning.

---

## Config knobs summary

| Knob | Required | Default | Purpose |
|------|:--:|---------|---------|
| `paperclipBaseUrl` | | `http://localhost:3100` | **Internal** API URL the worker calls directly. Keep it on an address that bypasses Access (loopback/private) unless using a service token. |
| `paperclipPublicUrl` | | — | **Public** hostname embedded in Telegram deep-links for humans. This is the Access-protected address. |
| `cfAccessClientIdRef` | | — | Secret-ref UUID → `CF-Access-Client-Id` header on plugin → board calls. |
| `cfAccessClientSecretRef` | | — | Secret-ref UUID → `CF-Access-Client-Secret` header on plugin → board calls. |

See the [Configuration Reference](configuration.md) for the full list of settings.

---

## Caveat: `url:` deep-link buttons behind Access

Cloudflare Access service tokens fix the **plugin → board API** leg (Approve/Reject buttons and `/approve` are driven by `callback_data`, which round-trips through the bot and the server-side worker — so they carry the `CF-Access-*` headers and work behind Access).

They do **not** fix **`url:` deep-link buttons**. Buttons such as **Open `<issue>` ↗**, agent links, and **View Run ↗** are Telegram inline-keyboard buttons with a `url:` field that opens the **public UI** (`paperclipPublicUrl`) directly in the board user's browser. Telegram (and the user's browser) cannot present a Cloudflare Access service token, so the button opens the Access login page unless the browser **already has an authenticated Access session**.

For a board user who is already signed in to Cloudflare Access in their browser, these links work transparently. For everyone else, they hit a login challenge. To avoid surprises, choose one of:

1. **Rely on `callback_data` actions (recommended).** Approve/Reject and other in-chat actions work through the bot regardless of the user's browser session. Treat `url:` buttons as a convenience, not the primary control surface.
2. **Add a Cloudflare Access bypass policy for read-only deep links.** If you want deep-links to open without a login prompt, add an Access policy that bypasses authentication for the read-only issue/agent/run view paths. Scope it tightly — this exposes those views publicly.
3. **Suppress `url:` buttons when Access is enabled.** Where the login round-trip is more confusing than helpful, omit the deep-link buttons entirely (an optional plugin flag to drop `url:` buttons when Access is configured is tracked as a follow-up; until it lands, the bypass-policy or callback-only approaches above are the supported options).

---

## See also

- [Configuration Reference](configuration.md) — every setting and default.
- [Getting Started](getting-started.md) — board access for approvals.
- [Troubleshooting](troubleshooting.md#approval-buttons-dont-work) — when approval buttons fail.
- Cloudflare docs: [Service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) · [Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/).
