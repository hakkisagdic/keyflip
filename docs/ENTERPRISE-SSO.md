# Enterprise / SSO sign-in — validation plan (roadmap #7)

The SSO path is **wired**; what remains is live end-to-end validation on a real SSO
organization (device-gated — needs an org with SSO/2FA enforced). This doc is the
checklist to run once such an org is available, plus what to watch for.

## What's already implemented

- `keyflip login [name] --email <x> --sso [--console]` forwards `--sso` to the official
  `claude auth login --sso` (see `src/login.js` → `performLogin`/`performLoginManual`,
  `args.push('--sso')`), captured into an **isolated** config dir — the current login is
  never disturbed.
- `keyflip onboard --sso [--console]` applies the same flags to **every** OAuth sign-in in
  that run (`src/cli.js` `cmdOnboard`).
- The interactive parts (org picker, IdP redirect, 2FA prompt) are driven by
  `claude auth login` itself via `stdio:'inherit'` / the manual paste flow — keyflip does
  not reverse-engineer the OAuth; it only wraps the official command.
- `--manual` covers IdP flows that hand back a code/redirect URL to paste.

## Validation checklist (run on a real SSO org)

1. **`keyflip login work --email you@corp.com --sso`**
   - [ ] Browser opens on the corporate IdP; complete SSO + 2FA.
   - [ ] If the account belongs to multiple orgs, the **org picker** appears and a choice
         sticks (capture records the chosen org's `organizationUuid`).
   - [ ] On return, keyflip captures the token; `keyflip list` shows the account with the
         right email + org; `keyflip status` shows it active on the CLI.
   - [ ] The user's **prior** login is intact (isolated capture didn't disturb it).
2. **`keyflip login work --email you@corp.com --sso --manual`**
   - [ ] The paste-the-code/URL flow completes an IdP round-trip that can't auto-return.
3. **`keyflip onboard --sso`**
   - [ ] Per-account SSO sign-in works; the browser is signed out between accounts so the
         2nd account is a fresh IdP login (not silently the first).
   - [ ] Mixing is possible: `p` still adds an API-key provider mid-run.
4. **Switching:** `keyflip work --force` / `--restart` moves the SSO account like any other
   (it's an OAuth subscription once captured).
5. **Token refresh:** after the 5h/7d window, `keyflip` refreshes the SSO token
   transparently (`oauth.maybeRefreshProfile`) — confirm no re-SSO is forced mid-run, and
   that a `refresh-failed` cleanly tells the user to re-`login --sso`.
6. **`--console`:** `keyflip login work --console` captures an Anthropic **Console** (API)
   account rather than a claude.ai subscription — verify the captured credential type.

## Things to watch for (likely failure points)

- **Org picker non-determinism:** if `claude auth login` returns before the org is chosen,
  the captured `organizationUuid` may be wrong → the desktop/browser mismatch + tug-of-war
  checks would compare against the wrong org. Capture the org from the minted token, not a
  cached value. (keyflip already reads `oauthAccount.organizationUuid` from the isolated
  login result — confirm it reflects the picked org.)
- **2FA timeout:** a slow 2FA can exceed the login subprocess timeout → surface a clear
  "sign-in timed out, re-run" rather than a stack trace.
- **Multiple SSO accounts, one browser session:** the same mismatch caveat as consumer
  accounts — the browser's claude.ai session must be the target account, or
  `--fresh`/`keyflip browser logout` first. Documented already.
- **Auto-naming collisions:** two `@corp.com` accounts in different orgs → `core.autoName`
  must disambiguate (it already domain-disambiguates then numbers; confirm on real data).

## Automated coverage (no SSO org needed)

- ✅ `test/login.test.js` asserts `login.buildLoginArgs({sso, useConsole, email})` includes
  `--sso`/`--console`/`--email` in the built `claude auth login` argv — and that `--sso`
  never appears unless asked. Both `performLogin` and `performLoginManual` build their argv
  through this one helper, so the wiring can't silently drift before live validation.
