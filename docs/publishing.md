# Publishing to npm

This package is published to the public npm registry as
**`@odience/paperclip-plugin-telegram-enhanced`** under the `@odience` organization scope.

> Reference: npm docs — [Creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
> and [About access tokens](https://docs.npmjs.com/about-access-tokens) (verified June 2026).

## One-time account setup (npm account owner)

These steps require ownership of the npm account and 2FA, so they must be done by
a human with access to the `@odience` npm account. They are needed only once.

1. **Create / confirm the npm organization.** Sign in at <https://www.npmjs.com> and
   create an organization named **`odience`** (Account menu → *Add organization*).
   A free org allows unlimited **public** packages. The org name must match the
   package scope exactly (`@odience`).
2. **Enable 2FA** on the account (Account → Two-Factor Authentication). Publishing a
   new package requires either an interactive 2FA prompt or a granular token with the
   *2FA bypass* setting.
3. **Create a Granular Access Token** (Account → *Access Tokens* → *Generate New Token*
   → *Granular Access Token*). As of November 2025 **only granular tokens** are
   supported; classic/automation tokens have been removed. Configure it as:
   - **Expiration:** your policy (e.g. 90 days).
   - **Packages and scopes:** *Read and write*, scoped to the **`@odience`** scope
     (or to this specific package after the first publish).
   - **Organizations:** not required for publishing. ⚠️ Org-level access only manages
     org settings/teams — it does **not** grant publish rights. Publish rights come
     from the *Packages and scopes* permission above.
   - **2FA bypass:** enable it if the token will be used non-interactively (CI). Leave
     it off if you will publish interactively and approve the 2FA prompt.
   - Copy the token (`npm_…`) once — it is shown only at creation.

## Publishing

The repo is already configured for a scoped **public** publish:
`package.json` sets `"name": "@odience/paperclip-plugin-telegram-enhanced"` and
`"publishConfig": { "access": "public" }`, so `--access public` is implied.
`prepublishOnly` runs the build, so `dist/` is produced fresh from source.

### Option A — interactive (run locally, approve 2FA in browser/app)

```bash
npm login                 # sign in as an @odience member with publish rights
npm publish               # access:public comes from publishConfig
```

### Option B — token-based / CI (no interactive prompt)

```bash
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc   # NPM_TOKEN = granular token
npm publish
rm -f .npmrc                                                     # never commit this file
```

In GitHub Actions, store the token as the `NPM_TOKEN` repo secret and use
`actions/setup-node` with `registry-url: 'https://registry.npmjs.org'`, then
`npm publish` with `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.

### Verify before publishing

```bash
npm install --include=dev   # NODE_ENV=production hosts skip devDeps without this
npm run build
npm test
npm pack --dry-run          # confirm name/version/files in the tarball
```

## Versioning

Bump the version before each release (`npm version patch|minor|major`).
npm will reject re-publishing a version that already exists. The current release
line is `0.x`; the first published version is `0.6.1`.
