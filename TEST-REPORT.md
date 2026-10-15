# IRON ID Mail — Test and Security Audit Report

## Update 2026-10-15 (night) — Own domains and payments (branch `i18n-en-fr`)

Same local stack, gateway started with `OWN_DOMAINS_ENABLED=true` and the test-only fakes for payments
(`PAYMENTS_FAKE`), the registrar (`REGISTRAR=fake`) and DNS; the old-mailbox copy runs against the local engine's IMAP.

| Check | Result |
|---|---|
| End-to-end tests, all files (13) | **102 / 102 passed**: 101 in the full run (incl. 11 new tests in `12-domains-billing.test.js`) + the restart test with a real restart |
| Translation coverage | **OK** — 1,341 texts, 967 French entries; gateway 289 |
| Security audit | 0 dependency problems (incl. the new `imapflow` 2.1.2); semgrep 0 new real problems (3 SQL "template" hits use fixed text with numbered parameters; TLS checks are off only in the test switch; MD5 is the signature OpenSRS requires); HTTP probe 42/45 with 4 new checks (Stripe webhook refuses unsigned calls, no fake payment page, payments live or off, no test switches) — the 3 "failures" are the test switches and recovery login left on in the test copy |
| Independent review (separate agent) | Findings fixed and covered by tests: a second payment for the same domain could deliver twice → second one marked failed for a refund; a bought domain could be removed while still paid for → refused; another client's pending claim on a bought domain → dropped, active claim → delivery fails safely; cancelled payment pages left orders "pending" → cancelled on return and after a day; prices/VAT saved half-way on a bad value → all checked first; the connect order had no terms checkbox → required |
| Engine under load | Two flaky tests (one also failed in GitHub CI after the sign-up deploy) traced to the engine refusing directory reads made at the same moment → the gateway shares one read between simultaneous requests, asks the engine again (3 times, short pause) after a request-level refusal, and sign-up uses the last address list if the engine cannot answer. Full run repeated after the fix: 101/101 + restart |

Domain/payment tests: prices with VAT; search (registrar availability, endings from settings, bad names); buying
(owner details checked, EU owner for .fr/.eu, paid once, a second payment never delivered twice, registered, DNS
published, invoice numbered and gap-free, not removable); addresses on the domain arriving in the same mailbox and
usable as sender; connecting an owned domain (€2, DNS records with live checks, verification, addresses); copying an
old mailbox over IMAP (only with the €2 service, wrong password and non-IMAP ports refused, one at a time, folders,
dates and read state kept); the admin console (payments, totals per client, invoices, prices and VAT changed and put
back); a webhook without Stripe's signature refused; removing a domain removes its addresses.
Checked by screenshots only (not automated yet): the webmail "Your domains" pages and the console's Payments and
settings pages in EN/FR at desktop and phone width, including the renewal notice. Not covered: renewal payment and
expiry end to end, the real Stripe and OpenSRS services (no accounts yet).

---

## Update 2026-10-15 (evening) — Sign-up for name@iron-id.io (branch `i18n-en-fr`, on top of the clean history `1e52414`)

Same local stack, gateway started with `SIGNUP_ENABLED=true`.

| Check | Result |
|---|---|
| End-to-end tests, all files (12) | **91 / 91 passed**: 90 in the full run (incl. 8 new sign-up tests in `11-signup.test.js`) + the restart test with a real restart |
| Translation coverage | **OK** — 1,011 texts, 719 French entries; gateway 237 |
| Security audit | 0 dependency problems; semgrep 0 errors after one fix (suggested names used `Math.random`), 1 known warning; HTTP probe 40/41 with 3 new sign-up checks (the 1 "failure" is the recovery login left on in the test copy) |
| Independent review (separate agent) | 1 critical + 3 high findings, **all fixed and covered by tests**: an address listed as admin (`PLATFORM_ADMINS` / `cp.admins`) but without a mailbox could be claimed by sign-up and get the admin console → such addresses are now refused; the per-network limit could be exceeded with parallel requests → counted and reserved under a database lock (test sends 5 at once: exactly 3 pass); re-using a deleted address failed after creating the account → new log table, account creation never reported as a failure once done; a deleted mailbox's recovery address could pass to the next owner → removed on delete and on sign-up. Also fixed: IPv6 limits per /64, bounded memory for the request brake, look-alike reserved names (`ir0nid`, `help.desk`, `x.admin`…), non-object request bodies |

Sign-up tests: open/closed state and page policy; address format/reserved/taken with suggestions, admin addresses
refused, form posts and other websites refused; every rule refused before the puzzle is spent (name, reserved,
short/simple/common/name-containing passwords, bad or in-house recovery address, terms) and in French; the puzzle
(wrong answer, forged signature, missing, used twice); a new account signed in with its language and an unread
welcome message, its password working at the normal sign-in, the address then taken; the limit under parallel
requests; the page in a real browser (link from the sign-in card, taken address blocks, password rule, puzzle,
terms, then the mailbox with the welcome message); the page in French on a phone (no sideways scroll) and the
draft legal pages.

---

## Update 2026-10-15 — English and French (branch `i18n-en-fr`)

Same local stack as below (real Stalwart 0.16.23, PostgreSQL 16, OpenSearch 2.19.3, gateway, Chromium).

| Check | Result |
|---|---|
| End-to-end tests, all files (11) | **83 / 83 passed**: the 77 existing tests unchanged (English output identical), 5 new language tests (`10-languages.test.js`), and the restart test with a real restart |
| Translation coverage (`tests/i18n/check-translations.js`) | **OK** — 942 webmail/admin texts and every gateway message have French (668 + 219 entries); placeholders identical in both languages |
| Security audit (`run-audit.sh`) | Same as 2026-10-14: 0 dependency problems, working tree clean, semgrep 0 errors / 1 known warning, HTTP probe 37/38 (recovery login left on in the test copy) |
| Independent review (separate agent, read-only) | 1 real bug found and fixed before commit: in French, dates coming from the database (recent sign-ins, activity log, domain dates) showed "Invalid Date". Also fixed: a database error while saving the language could fail a sign-in; the language picked on the sign-in screen now expires after 30 min (shared computers); a cookie-blocked browser can't loop on reload |

New tests in `10-languages.test.js`: page served in the browser's language (English default, cookie wins, bad
cookie ignored); gateway errors in French and unchanged in English; language saved to the account, returned at
sign-in and by `/account/me`, dates intact in French answers; webmail in French in a real browser (sign-in
buttons, folders, search, no English left on the main screen, Preferences switch back to English); admin console
in French.

Known change in English: dates now always use day/month order (`en-GB`) instead of the browser's own format.

---

| | |
|---|---|
| Date | 2026-10-14 (Africa/Algiers) |
| Version tested | commit `b0df570` "Security audit fixes and audit tooling" (on `027e512`, `991897b`, Phase 3a, Phase 2, `888ee67`) |
| Where | Local copy of the production stack in the cloud workspace: the real Stalwart 0.16.23 engine, PostgreSQL 16, secured OpenSearch 2.19.3, the gateway, and Chromium (Playwright 1.56.0) for browser tests |
| Not tested here | Production itself (Railway), the Docker image build (`run-docker.sh` needs Docker; runs in GitHub Actions), real internet mail delivery (needs the VPS) |

## 1. Summary

| Check | Result |
|---|---|
| End-to-end tests (10 files) | **78 / 78 passed** (77 in the full run + the restart test run separately with a real restart) |
| Dependency audit (`npm audit`, webmail + tests) | **0** known vulnerabilities |
| Secrets in the working tree (gitleaks) | **0** |
| Secrets in git history (gitleaks) | 5 hits in the old `engine/tenants.json` (mock data, file now removed) — plus the manual findings below |
| Static analysis (semgrep, 17 repository rules, 34 files) | **0 errors**, 1 warning (open item: Node installed by the NodeSource script) |
| HTTP security probe (38 read-only checks) | **37 / 38** on the local copy — the 1 "failure" is the recovery login, deliberately left on in the test copy |
| Independent manual reviews | 2 reviews: 11 findings on the admin console + 15 on the whole codebase. **All code-level findings fixed**; 4 need action by IRON ID (§4.4); the rest are open items for the VPS move (§4.5) |

**Most important result:** the audit found that the stored passwords of **charaf@iron-id.io** and
**anis@client.dz** match passwords that appear in this repository's git history. **Change both passwords in
production now** (and those of admin@ and contact@ to be safe). See §4.4.

## 2. How the tests were run

```
# local stack: tests/e2e helpers + /tmp/claude-0/oss/up.sh (Postgres, OpenSearch, engine, gateway)
cd tests/e2e
BASE_URL=http://127.0.0.1:3311 ENGINE_URL=http://127.0.0.1:8080 RECOVERY_ADMIN=… \
DNS_FAKE_FILE=… EXPECT_OPENSEARCH=1 OPENSEARCH_TEST_URL=https://127.0.0.1:9200 OPENSEARCH_TEST_PASSWORD=… \
node --test --test-concurrency=1 --test-timeout=420000 ./*.test.js
# the restart test, with a real restart of engine + gateway
RESTART_CMD="bash redeploy.sh" node --test 04-restart.test.js
# security audit
bash tests/security/run-audit.sh http://127.0.0.1:3311
```
The gateway under test was started with `PLATFORM_ADMINS=charaf@iron-id.io,e2e-platform-admin@iron-id.io` and
`IRONID_DNS_FAKE=<file>` (DNS answers for the domain-verification tests come from that file). Every test creates
its own throwaway mailboxes, domains and customers and deletes them afterwards.

## 3. End-to-end tests

Times are for the test bodies only (start-up such as launching the browser is not included). The two-step tests
take longest because they wait for fresh 30-second codes.

| File | What it covers | Tests | Passed | Time |
|---|---|---:|---:|---:|
| `00-secretbox.test.js` | Encryption of stored secrets (unit) | 3 | 3 | 0.0 s |
| `01-gateway.test.js` | Gateway: headers, closed routes, proxy allow-list, sign-in, cookies, CSRF, sign-in brake | 11 | 11 | 6.4 s |
| `02-webmail.test.js` | Webmail security in a real browser: CSP, no password in storage, hostile email and attachments | 8 | 8 | 5.4 s |
| `03-engine-admin.test.js` | Gateway engine access: key, role permissions, service account | 3 | 3 | 0.0 s |
| `04-restart.test.js` | Data and sign-ins survive a restart | 1 | 1 | 6.4 s |
| `05-search.test.js` | Mail search on OpenSearch, OpenSearch lock-down | 4 | 4 | 2.0 s |
| `06-webmail-features.test.js` | Every webmail feature in a real browser | 14 | 14 | 17.3 s |
| `07-account-security.test.js` | Two-step sign-in, app passwords, browsers, password change, proxy management block | 11 | 11 | 167.4 s |
| `08-admin-console.test.js` | Admin console API: roles, scoping, domains/DNS, DKIM, mailboxes, teams, plans, audit | 16 | 16 | 3.3 s |
| `09-teams-labels-admin-ui.test.js` | Team mailboxes, labels and admin console in a real browser | 7 | 7 | 17.0 s |
| **Total** | | **78** | **78** | **225 s** |

#### `00-secretbox.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | round trip works only in the same context | ✅ Pass | 0.00 s |
| 2 | tampered or truncated values are rejected | ✅ Pass | 0.00 s |
| 3 | each encryption uses a fresh IV | ✅ Pass | 0.00 s |

#### `01-gateway.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | health check reports gateway, engine and database up | ✅ Pass | 0.07 s |
| 2 | security headers are set | ✅ Pass | 0.01 s |
| 3 | debug page and admin API are closed | ✅ Pass | 0.01 s |
| 4 | proxy only forwards mail (JMAP) paths | ✅ Pass | 0.01 s |
| 5 | malformed request gets 400 and the server stays up | ✅ Pass | 0.01 s |
| 6 | wrong password is refused without a browser password popup | ✅ Pass | 0.44 s |
| 7 | the proxy never passes on credentials the caller supplies (no password guessing past the sign-in brake) | ✅ Pass | 0.01 s |
| 8 | signing in to your own mailbox does not reset the brake for guessing others | ✅ Pass | 3.31 s |
| 9 | sign-in sets a secure session cookie; sign-out ends it | ✅ Pass | 0.06 s |
| 10 | requests from another website are refused | ✅ Pass | 0.01 s |
| 11 | password guessing is slowed down, even with faked addresses | ✅ Pass | 2.43 s |

#### `02-webmail.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | page has a strict security policy and loads nothing from other sites | ✅ Pass | 0.58 s |
| 2 | sign-in keeps the password out of browser storage | ✅ Pass | 0.83 s |
| 3 | hostile HTML email is shown safely: no scripts, forms, frames or tracking pixels | ✅ Pass | 0.69 s |
| 4 | hostile attachment downloads inside a sandbox instead of opening on the site | ✅ Pass | 0.01 s |
| 5 | reply buttons fill in the right people | ✅ Pass | 0.94 s |
| 6 | stays signed in after reload; sending works | ✅ Pass | 0.63 s |
| 7 | password change works, old password stops working, other devices are signed out | ✅ Pass | 1.36 s |
| 8 | sign-out sticks; no popups or page errors | ✅ Pass | 0.31 s |

#### `03-engine-admin.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | gateway has working engine admin access | ✅ Pass | 0.02 s |
| 2 | gateway role grants only the expected permissions | ✅ Pass | 0.01 s |
| 3 | gateway service account uses only its custom role (no mail rights) | ✅ Pass | 0.00 s |

#### `04-restart.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | mail, passwords and sign-ins survive a restart (run separately with a real restart) | ✅ Pass | 6.36 s |

#### `05-search.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | health check reports OpenSearch search | ✅ Pass | 0.18 s |
| 2 | new mail is searchable, including stems and hyphenated words | ✅ Pass | 1.11 s |
| 3 | search ignores accents, French elisions and Arabic spelling variants | ✅ Pass | 0.06 s |
| 4 | search service refuses anonymous, wrong-password and out-of-scope access | ✅ Pass | 0.69 s |

#### `06-webmail-features.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | compose with Cc, Bcc and an attachment; draft saves itself, then goes to Sent | ✅ Pass | 5.90 s |
| 2 | recipients get it; the Bcc recipient stays hidden | ✅ Pass | 0.14 s |
| 3 | reply all keeps the conversation together for the recipient | ✅ Pass | 3.74 s |
| 4 | closing keeps a draft; it reopens and can be discarded | ✅ Pass | 0.79 s |
| 5 | search box finds mail on the server, including codes with hyphens | ✅ Pass | 0.16 s |
| 6 | reading, starring and archiving keep the other flags (old bug) | ✅ Pass | 1.19 s |
| 7 | folders: create, move a conversation in, rename, refuse deleting a full folder | ✅ Pass | 1.56 s |
| 8 | delete forever in Trash keeps copies filed in other folders | ✅ Pass | 0.52 s |
| 9 | new mail appears by itself (live updates) | ✅ Pass | 0.38 s |
| 10 | pictures attached inside an email are shown; internet pictures wait for permission | ✅ Pass | 1.42 s |
| 11 | profile, signature and out-of-office are saved to the mailbox | ✅ Pass | 0.75 s |
| 12 | keyboard shortcuts move through and act on conversations | ✅ Pass | 0.20 s |
| 13 | phone layout shows one pane at a time | ✅ Pass | 0.55 s |
| 14 | no page errors or browser popups along the way | ✅ Pass | 0.00 s |

#### `07-account-security.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | the mailbox password is not what the webmail session uses | ✅ Pass | 0.58 s |
| 2 | security tab shows two-step off and this browser | ✅ Pass | 0.41 s |
| 3 | turning on two-step sign-in | ✅ Pass | 1.17 s |
| 4 | sign-in needs the code; wrong and reused codes are refused | ✅ Pass | 45.72 s |
| 5 | signing in through the page asks for the code | ✅ Pass | 29.44 s |
| 6 | signed-in browsers: another browser can be signed out | ✅ Pass | 0.56 s |
| 7 | app password for a mail app: created once, works, can be revoked | ✅ Pass | 1.85 s |
| 8 | password change with two-step on needs the code and signs out other browsers | ✅ Pass | 58.02 s |
| 9 | turning two-step off again | ✅ Pass | 29.63 s |
| 10 | engine management calls are blocked through the webmail connection | ✅ Pass | 0.04 s |
| 11 | no page errors or browser popups | ✅ Pass | 0.00 s |

#### `08-admin-console.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | only signed-in admins get in | ✅ Pass | 0.77 s |
| 2 | plan and customer | ✅ Pass | 0.02 s |
| 3 | domain: pending until the DNS proof is found, then created with fresh DKIM keys | ✅ Pass | 0.11 s |
| 4 | the platform domain never offers exposed keys or MX changes | ✅ Pass | 0.01 s |
| 5 | mailboxes: create with a temporary password, plan limits, quota | ✅ Pass | 0.24 s |
| 6 | customer admins only see and change their own customer | ✅ Pass | 0.20 s |
| 7 | aliases stay within the customer’s domains | ✅ Pass | 0.02 s |
| 8 | teams: shared mailbox with members, visible in their webmail | ✅ Pass | 0.61 s |
| 9 | suspend and restore a mailbox | ✅ Pass | 0.29 s |
| 10 | reset sign-in: new password, two-step and app passwords removed, browsers signed out | ✅ Pass | 0.75 s |
| 11 | DKIM: new keys, switch only once published, then remove the old ones | ✅ Pass | 0.09 s |
| 12 | catch-all address must be on the domain | ✅ Pass | 0.02 s |
| 13 | usage and billing estimate | ✅ Pass | 0.01 s |
| 14 | retention rule for Trash and Junk (platform) | ✅ Pass | 0.01 s |
| 15 | audit log: sign-ins and changes, scoped per customer | ✅ Pass | 0.01 s |
| 16 | delete: team, mailbox, domain (with confirmation), customer | ✅ Pass | 0.10 s |

#### `09-teams-labels-admin-ui.test.js`

| # | Test | Result | Time |
|---:|---|---|---:|
| 1 | the team mailbox shows up in the sidebar; no Admin link for ordinary users | ✅ Pass | 1.51 s |
| 2 | open the team inbox and assign a conversation to me | ✅ Pass | 0.56 s |
| 3 | Bob sees the assignment | ✅ Pass | 0.06 s |
| 4 | reply from the team mailbox goes out as the team | ✅ Pass | 6.98 s |
| 5 | labels: create, apply, open the label, rename, delete | ✅ Pass | 4.82 s |
| 6 | admin console in the browser: mailbox created, suspended, deleted; team listed | ✅ Pass | 3.07 s |
| 7 | no page errors or browser popups | ✅ Pass | 0.00 s |

## 4. Security audit

### 4.1 Tools
| Tool | What it checks | Result |
|---|---|---|
| `npm audit` | Known-vulnerable packages: `webmail` (pg 8.23.0, qrcode-generator 1.4.4), `tests/e2e` (playwright 1.56.0) | 0 moderate/high/critical |
| gitleaks 8.24.2 | Secrets in files and in all 35 commits | Tree clean. History: 5 "generic API key" hits, all in `engine/tenants.json` (mock data from the old console; removed in `b0df570`) |
| semgrep 1.180.0 + `tests/security/semgrep-rules.yml` | SQL built from strings, shell/code injection, `innerHTML` and `html:` with variables, unsafe links, `postMessage`, weak random/hash, timing-unsafe secret compares, TLS checks off, secrets in logs, CORS `*`, path traversal, Dockerfile download/pipe patterns, secrets echoed in shell | 1 warning (below). 5 matches reviewed as safe and marked in the code with the reason (`nosemgrep`) |
| `tests/security/http-probe.js` | Headers, CSP, closed routes, path traversal, proxy behaviour, CSRF, CORS, sign-in answers, oversized/malformed bodies, `/healthz` | 37/38 (output below) |

(The public semgrep rule registry and Trivy downloads are blocked by this workspace's network policy, so the
repository's own rules were written and used; the GitHub Actions workflow `security.yml` runs the same audit.)

<details><summary>HTTP probe output (local copy)</summary>

```
PASS  webmail page loads  (HTTP 200)
PASS  header x-frame-options  (DENY)
PASS  header x-content-type-options  (nosniff)
PASS  header referrer-policy  (no-referrer)
PASS  webmail CSP: scripts only from this site  (default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src)
PASS  webmail CSP: no framing, no plugins, no base tag
PASS  admin console page has a strict CSP  (HTTP 200)
PASS  admin API needs a session
PASS  account API needs a session
PASS  mail session is empty without signing in
PASS  mail API refuses calls without a session  (HTTP 401)
PASS  closed: /debug  (HTTP 404)
PASS  closed: /api/stats  (HTTP 404)
PASS  closed: /admin-legacy  (HTTP 404)
PASS  closed: /admin.html  (HTTP 404)
PASS  closed: /proxy/api/principal  (HTTP 404)
PASS  closed: /proxy/  (HTTP 404)
PASS  closed: /proxy/jmap/../api/principal  (HTTP 404)
PASS  closed: /proxy/%2e%2e/api  (HTTP 404)
PASS  closed: /proxy/jmap//  (HTTP 404)
PASS  closed: /app/../server.js  (HTTP 404)
PASS  closed: /app/%2e%2e/server.js  (HTTP 404)
PASS  closed: /app/js/../../server.js  (HTTP 404)
PASS  closed: /.env  (HTTP 404)
PASS  closed: /package.json  (HTTP 404)
PASS  no password popup / no engine auth through the proxy
PASS  sign-in refuses other websites  (HTTP 403)
PASS  admin API refuses form posts  (HTTP 415)
PASS  no CORS for other sites on /  (none)
PASS  no CORS for other sites on /admin-api/me  (none)
PASS  no CORS for other sites on /proxy/jmap/session  (none)
PASS  no CORS for other sites on /healthz  (none)
PASS  unknown address: same answer as a wrong password  (HTTP 401 Invalid mailbox credentials)
PASS  oversized sign-in body refused  (HTTP 0)
PASS  malformed JSON refused  (HTTP 400)
PASS  healthz has no secrets  ({"gateway":"ok","engine":"ok","database":"ok","schema":"ok","adminAccess":"ok","recoveryAdminSet":true,"search":"ok"})
FAIL  recovery admin login is not left set  (recoveryAdminSet=true)
PASS  gateway engine access is ok  (adminAccess=ok)

37/38 checks passed against http://127.0.0.1:3311
```
</details>

### 4.2 Manual review 1 — admin console (commit `991897b`)
| Severity | Finding | Status |
|---|---|---|
| High | An unverified (pending) domain claim already gave access to that domain's mailboxes | Fixed: only verified domains count; claims lapse after 7 days; max 5 per customer; existing engine domains only assigned by staff |
| High | Plan limits could be bypassed (clear quota = unlimited; unlimited free teams; two parallel creates) | Fixed: falls back to the plan; teams limited and given the plan's storage; one create at a time per customer |
| Medium | Admin rights followed an address after its mailbox/domain was deleted; customer admins could reset another customer's admin | Fixed: admin only for existing mailboxes of that customer; rights cleared on delete; such mailboxes protected |
| Medium | Teams and team members skipped the protected-account check | Fixed |
| Medium | Two membership changes at once could undo each other | Fixed (patch updates) |
| Medium | Undo after switching between own and team mailbox acted on the wrong mailbox | Fixed |
| Low/Med | Every webmail load read the whole directory including masked credentials | Fixed (credentials only for the mailbox list) |
| Low | Domain removal ignored aliases on other mailboxes | Fixed |
| Low | Failed sign-ins for made-up addresses could flood a customer's activity log | Fixed (only real addresses; 180-day retention) |
| Low | Gateway role carries ordinary mailbox permissions | Accepted (engine requirement); documented |
| Low | Aliases sent as a non-list cleared all aliases; suspend dropped other permission settings; labels on team mail; dropped forwarded attachments not reported | Fixed (labels limited to the own mailbox) |

### 4.3 Manual review 2 — whole codebase (commit `027e512`)
| Severity | Finding | Status |
|---|---|---|
| Critical | Seed accounts charaf@ and anis@ have password hashes matching passwords in git history | **Action needed** (§4.4). Fresh databases are now protected automatically (`seedGuard.js`, tested: marker consumed, 7 seeded mailboxes given random passwords) |
| Critical | The seed dump holds more private keys than the known DKIM keys (likely the engine TLS key and a server secret) | **Action needed / VPS**: regenerate on the VPS; after the proxy fix below, nothing forged can reach the engine through the gateway |
| High | `/proxy` passed a caller-supplied `Authorization` header to the engine → unlimited password guessing, no audit | **Fixed** (`b0df570`): only the session's credentials are sent; new tests in `01-gateway` |
| High | Engine listeners bound to all interfaces (seed config) | Open, VPS (only the gateway port is public on Railway) |
| Medium | Old token console (`/api/*`, `/admin-legacy`, `admin-cli.js`) only edited a JSON file (a "suspend" did nothing) and had stored XSS | **Fixed**: removed (with its mock modules) |
| Medium | `ADMIN_TOKEN` is both a password typed in the old console and the encryption-key source | Partly fixed: no longer typed anywhere (old console removed); warning at start if weak. Separate key: open |
| Medium | Sign-in brake: a success on one's own mailbox reset the address's counter; clients could choose their address when no proxy is in front | **Fixed**: only the mailbox counter resets; `TRUST_PROXY=false` option. Per-mailbox lockout (30 failures) remains by design |
| Medium | Container hardening (root, NodeSource script, unchecked engine download, Postgres `trust`) | Engine download now **checksum-pinned**; the rest open |
| Medium | VPS compose files: HTTP without TLS, clear-text mail auth, default DB password | Open (not used in production) |
| Low | `/debug` route (token compared with `!==`, logs exposed when enabled) | **Fixed**: removed |
| Low | Proxy forwarded hop-by-hop and forwarding headers | **Fixed** |
| Low | `/healthz` shows setup state; OpenSearch certificate not verified | Accepted, documented |

Areas checked and found OK: static file serving (no traversal), JMAP management filter and size limit, attachment
sandboxing, session tokens (32 random bytes, stored hashed, rotated at sign-in, deleted at sign-out), CSRF on every
state-changing route, AES-256-GCM use (fresh IV, tag checked, bound to its row), two-step codes (window ±1,
constant-time, single use), CSP and headers, email rendering (DOMPurify 3.4.16, sandbox, frame CSP), no dangerous
`innerHTML` with untrusted data, no `postMessage` handlers, no open redirects, OpenSearch image hardening.

### 4.4 Actions for IRON ID (cannot be done in code)
1. Change the passwords of **charaf@iron-id.io** and **anis@client.dz** now; also admin@ and contact@; turn on
   two-step sign-in for charaf@ and every admin.
2. Treat everything in git history as exposed; rewrite history or start a clean repository before sharing the code.
3. Switch iron-id.io and client.dz to new DKIM keys in the admin console.
4. Consider demoting `admin@iron-id.io` (engine Admin role).

### 4.5 Open items (before or at the VPS move)
Engine listeners → 127.0.0.1; regenerate the seed's TLS key and secrets; non-root container and signed Node
install; TLS and no clear-text auth in the VPS stack; separate encryption key from `ADMIN_TOKEN`.

## 5. Problems the tests caught during this work (all fixed)
- Mailbox creation failed because the engine requires the creator to hold every permission it grants → gateway role
  extended; `03-engine-admin` updated to allow exactly the User/Group permissions on top of its own.
- `adminAccess` would have blocked search while the role awaited an update → `needs_update` keeps search running.
- Failed sign-ins for brand-new mailboxes were not recorded (address cache) → cache refreshes on a miss.
- The `07` two-step file needs about 170 s (waiting for fresh codes) → per-file timeout raised to 420 s.

## 6. Not covered
- Production: run `node tests/security/http-probe.js https://<production-domain>` after deploying (read-only).
- The Docker image build and CI run (`e2e.yml`, `security.yml`) — they run on GitHub after the push.
- Sending to and receiving from the internet (SPF/DKIM/DMARC alignment, blocklists, TLS on port 25): needs the VPS.
- Load and performance testing; accessibility audit; manual testing on real phones (phone layout is covered by
  browser tests at phone width).
