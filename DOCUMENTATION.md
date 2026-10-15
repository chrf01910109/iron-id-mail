# IRON ID Mail — Documentation

Business email on the customer's own domain, run by IRON ID. This document describes the system as of
**2026-10-14, commit `b0df570`** (plus this documentation commit). The separate file **TEST-REPORT.md**
records the tests and the security audit that were run on this version.

---

## 1. What it is

IRON ID Mail gives a company addresses such as `name@company.dz`, a webmail, shared team mailboxes and
an admin console, hosted by IRON ID.

| Area | What people get |
|---|---|
| Webmail | Conversations, search, safe display of HTML email, attachments, drafts, replies/forwards, folders, labels, keyboard shortcuts, phone layout, live updates |
| Account security | Two-step sign-in (authenticator app), app passwords for mail apps, signed-in browsers, recent sign-ins, password change |
| Team mailboxes | Shared addresses (support@, finance@): members see the mailbox, assign conversations, reply as the team |
| Admin console (`/admin`) | Customers, plans, domains with DNS verification, signing keys (DKIM), mailboxes, aliases, teams, activity log, usage & billing estimate, retention |

**Status.** Live in production up to Phase 1 + OpenSearch (commit `888ee67`). Phases 2, 3a, 3b and the
security fixes are built and tested but must still be deployed (see §8.3).

**Not built yet** (need the VPS, the Workspace platform or a payment account): sending to and receiving
from the internet at production quality (port 25, clean IP, reverse DNS), mail apps over IMAP/SMTP,
spam and virus filtering, the verified-sender badge, platform-shared accounts, attachments from
Storage, payment collection.

---

## 2. Architecture

```
                 Internet (HTTPS, Railway edge)
                              │
                ┌─────────────▼──────────────┐  Railway service "iron-id-mail" (one container)
                │  Gateway  (Node.js)        │  webmail/server.js  — the ONLY public door
                │  • webmail + admin pages   │
                │  • sign-in, sessions       │──────┐ Postgres (Railway service)
                │  • /account, /admin-api    │      │  schema cp  : control plane
                │  • JMAP proxy (allow-list) │      │  engine data: mail, accounts, keys
                └─────────────┬──────────────┘      │
                              │ 127.0.0.1:8080 (JMAP)│
                ┌─────────────▼──────────────┐      │
                │  Mail engine (Stalwart     │──────┘
                │  0.16.23, Rust)            │
                └─────────────┬──────────────┘
                              │ HTTPS, private network
                ┌─────────────▼──────────────┐  Railway service "opensearch"
                │  OpenSearch 2.19.3         │  full-text search index (no readable copies of mail)
                └────────────────────────────┘
```

**The engine** (Stalwart) stores domains, accounts, mail, signing keys and settings, and speaks JMAP
(RFC 8620/8621). It is the single source of truth for mail data.

**The gateway** (`webmail/`) is the only thing reachable from the internet. It:
- serves the webmail (`/`, `/app/*`) and the admin console (`/admin`) with strict security headers;
- signs people in and keeps a **server-side session** (HttpOnly cookie; the browser never holds a password);
- forwards a short **allow-list** of JMAP addresses to the engine with the session's credentials, and refuses
  any engine management call (`urn:stalwart:jmap`, `x:` methods) from the webmail;
- runs account actions (`/account/*`) and the admin console API (`/admin-api/*`), which reach the engine's
  management API with the gateway's own **scoped engine API key** after checking ownership;
- keeps the **control plane** in Postgres schema `cp` (customers, plans, admins, sessions, audit log, labels…).

**Trust boundaries.** Browser → gateway (HTTPS, cookie, same-site checks) → engine (localhost only from the
gateway; credentials only from the server-side session). The engine API key lives encrypted in the database;
the encryption key is derived from `ADMIN_TOKEN`, which only exists in Railway's variables.

---

## 3. Repository layout

| Path | What |
|---|---|
| `Dockerfile`, `railway.json` | The production container: Node 20, Stalwart 0.16.23 (checksum-pinned), optional built-in Postgres |
| `deploy/railway/entrypoint.sh` | Container start: database, one-time seed import, engine, gateway |
| `deploy/opensearch/` | The OpenSearch service (Dockerfile, entrypoint, index templates, README) |
| `deploy/docker-compose.yml`, `deploy-vps.sh`, `vps-setup.sh`, `config.toml` | Early VPS scripts — **not production-ready** (see §10.3) |
| `engine/export_data.json/` | Seed data imported on a fresh database (domains, settings, first accounts) |
| `webmail/server.js` | The gateway (all HTTP routes) |
| `webmail/services/` | `accountSecurity.js` (sign-in, two-step, app passwords), `sessionStore.js`, `secretBox.js` (encryption), `db.js` + `controlPlane.sql` (schema), `engineAdmin.js` (engine API key, role), `adminConsole.js` (/admin-api), `labels.js`, `dnsCheck.js`, `searchBackend.js`, `seedGuard.js` |
| `webmail/public/` | Webmail (`index.html`, `js/*.js`, `app.css`, `base.css`) and admin console (`admin.html`, `admin.css`, `js/admin/admin.js`); DOMPurify in `vendor/`; self-hosted fonts |
| `tests/e2e/` | End-to-end tests (real engine + Postgres + browser), `run-docker.sh` for CI |
| `tests/security/` | `run-audit.sh`, `semgrep-rules.yml`, `http-probe.js` |
| `.github/workflows/` | `e2e.yml` (end-to-end tests), `security.yml` (audit) |
| `server.js` (root) | Starts `webmail/server.js` |

---

## 4. Features in detail

### 4.1 Webmail
- Conversation list with paging, unread/starred filters, unread counts in the tab title.
- **Search** (OpenSearch): `from:` `to:` `cc:` `subject:` `has:attachment` `is:unread|read|starred`
  `before:` `after:` `in:all`, "exact phrases"; accents don't matter; matches are highlighted.
- **Safe HTML email**: DOMPurify + an iframe sandbox without scripts + a per-frame CSP. Internet pictures are
  blocked until "Show pictures" / "Always from this sender". Attachments download inside a sandbox with an
  opaque type unless they are plain images, PDF or text.
- Composer: identities (From), To/Cc/Bcc suggestions, attachments (button or drag-drop), draft autosave,
  reply / reply all / forward (keeps attachments), missing-attachment and no-subject checks.
- Folders (create, sub-folders, rename, delete when empty), move with Undo, archive, spam / not spam, trash,
  delete forever.
- **Labels**: a message can carry several labels across folders (keyword `label:<slug>`; names and colours
  are stored per person in `cp.labels`). Create from the sidebar or the reader's Label button (shortcut `l`),
  rename, recolour, delete (removes the label from messages). Labels apply to the person's own mailbox.
- **Team mailboxes** appear under "Team mailboxes" in the sidebar. In a team mailbox: **Assign** a conversation
  to a member (keyword `assigned:<email>`), **Assigned to me** filter, and replies/forwards go out from the
  team address (sent from the person's own mailbox with the team identity; team attachments are copied over).
- Settings: display name, signature, out-of-office, preferences, keyboard shortcuts, Security (below).
- Live updates (JMAP push), phone layout (one pane at a time).

### 4.2 Account security (Settings → Security)
- **Two-step sign-in** with an authenticator app (QR code + key). The gateway verifies the first code itself
  (the engine doesn't) and claims every code so it works only once.
- **App passwords** for mail apps (shown once, revocable; max 5 per mailbox, an engine limit).
- **Signed-in browsers**: sign out one or all others.
- **Recent sign-ins** (successful and failed, last 10).
- **Password change** (needs the current password, and the code when two-step is on; signs out other browsers).
- The webmail never uses the mailbox password after sign-in: each mailbox gets its own engine app password
  "IRON ID webmail" (30 days, stored encrypted), shared by its signed-in browsers.

### 4.3 Admin console (`/admin`)
Admins sign in to the webmail with their own mailbox; an **Admin** link appears in the header.

| Page | What it does |
|---|---|
| Overview | Counts, waiting domains, recent changes, warnings (two-step off on the admin's mailbox, gateway needs a permission update, recovery login still set) |
| Customers | (Staff) create/edit/suspend/delete customers, choose plan; add/remove each customer's admins |
| Domains | Add a domain → DNS records to publish with live Found/Missing status → Verify → domain created with fresh signing keys. Catch-all address. Change signing keys safely. Remove |
| Mailboxes | Create (one-time temporary password), edit name/storage/aliases, reset sign-in, suspend/restore, make admin, delete |
| Teams | Create shared mailboxes, choose members, aliases, delete |
| Activity log | Sign-ins and every change, newest first, search and filter |
| Usage & billing | Billable mailboxes × plan price per mailbox per month (estimate only) |
| Plans | (Staff) mailbox limit, storage per mailbox, price, currency |
| Platform settings | (Staff) how many days Trash and Junk keep messages; IRON ID staff admins |

**Domain verification flow**
1. Admin adds `company.dz` → status *Waiting for DNS*, token generated.
2. Customer publishes the records shown (host `@` = the domain itself):

| Record | Host | Value | Purpose |
|---|---|---|---|
| TXT | `@` | `iron-id-verification=<token>` | Proves ownership (required to verify) |
| MX | `@` | `10 mail.iron-id.io` | Delivers the domain's mail to IRON ID |
| TXT | `@` | `v=spf1 mx ~all` | Allows IRON ID to send for the domain (SPF) |
| TXT | `<selector>._domainkey` | `v=DKIM1; k=ed25519|rsa; p=…` | Signing keys (DKIM), two of them |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@company.dz` | DMARC, starting in monitoring mode |

3. **Verify** looks up the TXT record (Cloudflare, then Google DNS-over-HTTPS, then the system resolver) and
   creates the domain in the engine with gateway-generated Ed25519 + RSA-2048 keys.

Rules: an unverified claim gives no access to anything in that domain, lapses after **7 days**, and a customer
can have at most **5** waiting; a domain that already exists in the engine (set up before the console, e.g.
`client.dz`) is only **assigned** by IRON ID staff.

**Changing signing keys (DKIM)**: *Create new keys* (stage "pending", not used yet) → publish their two TXT
records → *Switch to the new keys* (allowed only once both are visible in DNS; old keys become "old") →
*Remove old keys*. Mail stays signed throughout.

**Platform domain (iron-id.io)**: the console never proposes MX/SPF/DMARC changes for it (Issam's Namecheap
mailbox must not be disrupted) and never shows the exposed selectors `v1-ed25519/rsa-20260921` (and
`-20260922` for client.dz) as something to publish; it warns to switch to new keys.

### 4.4 Languages (English and French)
The webmail, the admin console and the gateway's messages are available in **English and French**.

| | |
|---|---|
| Choosing | On the sign-in card (English / Français buttons), or Settings → Preferences → Language |
| Saved | On the account (`cp.user_prefs`), so it follows the person to every device; applied at sign-in and when the webmail loads |
| Before sign-in | The `ironid_lang` cookie (this browser's last choice), else the browser's language, else English |
| Dates and sizes | `en-GB` / `fr-FR` formats (day before month in both); sizes in Ko/Mo/Go in French |

How it is built (for developers):
- Text is written in English in the code and wrapped in `t('…')` (`tn()` for plurals, `tx('context', '…')` for a word
  with two French meanings, e.g. the folder "Archives" vs the action "Archiver"). Changing parts use `{placeholders}`.
- French lives in `webmail/public/js/i18n/fr/<file>.js`, keyed by the exact English text. Static text in
  `index.html`/`admin.html` needs no code: `i18n.js` translates the page's text and `placeholder`/`title`/
  `aria-label`/`alt` when it loads (`data-no-i18n` opts an element out). The page stays hidden until then (3 s fallback).
- Gateway messages are translated in `sendJson` (`webmail/services/i18n.js` + `i18n-fr.js`): `error`, and the admin
  console's `problem`/`purpose`/`warnings`/`protected` fields. Keys may contain `{x}` for parts that change.
- `node tests/i18n/check-translations.js` fails when any visible text has no French (run in CI). Adding a third
  language = one more dictionary folder + adding its code to `SUPPORTED` / `LANGS` on both sides.

---

## 5. Roles and permissions

| Who | How defined | Can |
|---|---|---|
| Mailbox user | Engine account | Use the webmail, own security settings, own labels; team mailboxes they belong to |
| Customer admin | Row in `cp.admins` (role `customer`, customer id); must be an existing mailbox on one of that customer's verified domains | Everything in the admin console for **their** customer, except plans, platform settings and other customers. Cannot change their own mailbox from the console, nor engine administrators, the gateway account, or admins of other customers |
| IRON ID staff (platform admin) | `cp.admins` role `platform`; addresses in `PLATFORM_ADMINS` are added back on every start | Everything, all customers |
| Engine administrator | Engine role `Admin` (e.g. `admin@iron-id.io`) | Read-only in the console (managed in the engine) |
| Gateway service account | `gateway@iron-id.io`, custom engine role, API key | What the console needs (see below). Never shown in lists |

**Gateway engine role** (`webmail/services/engineAdmin.js`): Domain CRUD, Account CRUD, DkimSignature CRUD,
MailingList CRUD, Role read, own API key, SearchStore read, Task get/query/create, store maintenance,
DataRetention get/update — **plus** every permission of the built-in *User* and *Group* roles, because the
engine only lets an account create mailboxes with permissions it holds itself. Those apply to the gateway's
own empty account; it has no access to other people's mail through them.

Suspension = engine permissions `Merge` with `disabledPermissions.authenticate`; reset sign-in = replacing
the account's credentials (new password, two-step and all app passwords removed).

---

## 6. Data (control plane, Postgres schema `cp`)

| Table | Holds |
|---|---|
| `settings` | Key/values: encrypted engine API key, one-time markers |
| `plans` | id, name, max_mailboxes, mailbox_quota_mb, price_per_mailbox, currency |
| `customers` | id, name, status, plan, contact, `internal` (the IRON ID customer owning iron-id.io) |
| `customer_domains` | domain → customer, verification token, status (pending/active), engine domain id |
| `admins` | email, role (platform/customer), customer |
| `audit_log` | time, actor, customer, action, target, details, IP. Sign-in entries kept 180 days |
| `sessions` | SHA-256 of the cookie, email, encrypted engine credential, created/last seen, IP, browser |
| `webmail_credentials` | Per mailbox: the webmail's engine app password (encrypted), expiry |
| `used_codes` | Two-step codes already used (hash), kept a few minutes |
| `labels` | Per person: slug, name, colour |
| `user_prefs` | Per person: language (`en`/`fr`) |
| `recovery` | Reserved for recovery e-mail addresses |

Migrations (`controlPlane.sql`) run on every start and are idempotent. Mail data, accounts, domains and keys
are in the engine's own tables in the same database. `ironid_meta` (public schema) holds entrypoint markers
(`seed_imported`, `seed_passwords_pending`).

---

## 7. Configuration (Railway variables of `iron-id-mail`)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres. Without it a database inside the container is used and **all mail is lost on redeploy** |
| `ADMIN_TOKEN` | yes | Secret from which the encryption key for stored secrets is derived. ≥ 32 random characters (`openssl rand -hex 32`). Changing it signs everyone out and needs the engine key set up again |
| `OPENSEARCH_URL` | for search | `https://${{opensearch.RAILWAY_PRIVATE_DOMAIN}}:9200` |
| `OPENSEARCH_PASSWORD` | for search | `${{opensearch.OPENSEARCH_PASSWORD}}` |
| `STALWART_RECOVERY_ADMIN` | **only during setup** | `recovery:<random>` — full engine admin. Set it, deploy, check /healthz, **remove it**, deploy (§8.2) |
| `PLATFORM_ADMINS` | no | Comma-separated IRON ID staff mailboxes (default `charaf@iron-id.io`) |
| `PLATFORM_DOMAIN` / `GATEWAY_ACCOUNT_DOMAIN` | no | Default `iron-id.io` |
| `MAIL_HOST` | no | MX host shown to customers (default `mail.iron-id.io`) |
| `TRUST_PROXY` | no | Default `true` (Railway). Set `false` if the gateway is reached directly, so clients can't choose their address for the sign-in brake |
| `TOTP_ISSUER` | no | Name shown in authenticator apps (default IRON ID) |
| `PORT` | set by Railway | Gateway port |
| `IRONID_DNS_FAKE` | **never in production** | Test-only file of fake DNS answers |
| `CONFIG_PATH` | **never set** | Breaks the engine's seed import |

---

## 8. Deployment and operations

### 8.1 Railway layout
- `iron-id-mail`: the container (gateway + engine). Public HTTPS domain.
- Postgres: Railway database service (`DATABASE_URL`).
- `opensearch`: search service on the private network, with a volume at `/var/lib/ironid-search`.

### 8.2 One-time engine access setup (and after permission changes)
The gateway needs its own engine API key, and its role must contain the permissions the running version uses.
`/healthz` field `adminAccess`: `ok` | `provisioned` (just created) | `needs_update` (role lacks permissions this
version uses) | `missing` (never set up) | `error`.
1. Set `STALWART_RECOVERY_ADMIN=recovery:$(openssl rand -hex 24)` on `iron-id-mail` (never print it).
2. Deploy; `/healthz` → `adminAccess` `ok`/`provisioned`, logs show `[engine-admin] … role updated` when needed.
3. **Remove the variable**, deploy; `/healthz` → `recoveryAdminSet: false`.

### 8.3 Deploying a new version
From `~/projects/iron-id-mail-git`: bring in the bundle (`git fetch <bundle> main:x && git merge --ff-only x`),
`git push origin main && git push origin main:master`, then `railway up --service iron-id-mail --detach`.
If the version adds engine permissions (Phase 3b does), follow §8.2. The step-by-step task file for
Claude Code is `DEPLOY-PHASE3B.md` (in `~/projects/email-iron-id/.backup-2026-10-12/`).
After deploying Phase 3a or later, everyone signs in once more.

**Rollback**: `railway` dashboard → previous deployment → Redeploy (the database schema only adds tables and
columns, so older versions keep working).

### 8.4 Health and logs
`GET /healthz` → `gateway`, `engine`, `database`, `schema`, `adminAccess`, `recoveryAdminSet`, `search`
(`ok` | `builtin` | `waiting-for-setup` | `restart-needed` | `reindexing` | `unreachable` | `auth-failed`).
HTTP 200 when gateway, engine, database and schema are fine. Logs (`railway logs`) use prefixes
`[auth]`, `[account]`, `[admin]`, `[engine-admin]`, `[search]`, `[seed]`, `[audit]`, `[db]`, `[secretbox]`.

### 8.5 Built-in protections that need no action
- **Sign-in brake**: after 10 failed attempts from one address, or 30 on one mailbox, within 15 minutes, further
  attempts get HTTP 429 until those 15 minutes have passed. A success resets only that mailbox's counter.
- **Sessions** end after 12 hours without activity and after 7 days in any case.
- **Seed protection**: on a *fresh* database the entrypoint imports the seed and leaves
  `seed_passwords_pending`; the gateway then gives every seeded mailbox a random password (use *Reset sign-in*
  in the console to hand out access). Production (seeded long ago) is never touched.
- **Audit pruning**: sign-in entries older than 180 days are removed daily.
- **Retention**: Trash and Junk are emptied after the number of days set in Platform settings (engine job, daily).

### 8.6 First steps after deploying Phase 3b
In `/admin` as `charaf@iron-id.io`: set plan prices (Plans), create customers, assign `client.dz` to its
customer (Domains → Assign), add each customer's admin, and turn on two-step sign-in for every admin mailbox.

---

## 9. Testing and audits

| What | Command | Notes |
|---|---|---|
| End-to-end tests (local) | `cd tests/e2e && BASE_URL=… ENGINE_URL=… RECOVERY_ADMIN=… DNS_FAKE_FILE=… npm test -- ./*.test.js` | Needs a running gateway started with `PLATFORM_ADMINS=…,e2e-platform-admin@iron-id.io` and `IRONID_DNS_FAKE=<same file>` |
| End-to-end tests (CI) | `bash tests/e2e/run-docker.sh` | Builds the real image, Postgres 16 and OpenSearch; runs every test. GitHub Actions `e2e.yml` |
| French translations complete | `node tests/i18n/check-translations.js` | No server needed. Lists every text without French, by file:line. GitHub Actions `security.yml` |
| Security audit | `bash tests/security/run-audit.sh [BASE_URL]` | npm audit, gitleaks (tree + history), semgrep (repo rules), HTTP probe. GitHub Actions `security.yml` weekly |
| Production probe (read-only) | `node tests/security/http-probe.js https://<domain>` | Safe on production: anonymous requests only |

Results for this version: see **TEST-REPORT.md**.

---

## 10. Security model and known risks

### 10.1 In place
HttpOnly + SameSite=Strict session cookie (Secure on HTTPS); sessions stored as SHA-256 only; secrets encrypted
with AES-256-GCM bound to their row; strict CSP on every page; no third-party requests; HTML email isolated;
attachments sandboxed; JMAP proxy allow-list, management calls refused, caller-supplied credentials and
hop-by-hop headers stripped; same-site + JSON-only for every change; two-step sign-in with single-use codes;
sign-in brake; every admin action audited; admin scope enforced on the server; engine download checksum-pinned.

### 10.2 Action needed (from the 2026-10-14 audit)
1. **Change the passwords of `charaf@iron-id.io` and `anis@client.dz` in production now.** Their stored password
   hashes match passwords that appear in this repository's git history. Also change `admin@iron-id.io` and
   `contact@iron-id.io` to be safe, and turn on two-step sign-in for charaf@.
2. **Treat everything in git history as exposed** (old passwords, the four DKIM keys, the seed's other keys).
   Rewriting history (git filter-repo) or starting a clean repository is recommended before sharing the code.
3. **Switch iron-id.io and client.dz to new signing keys** in the console (publishing the new DKIM TXT records
   doesn't touch MX/SPF/DMARC).
4. Consider demoting `admin@iron-id.io` (engine Admin role) to a normal mailbox.

### 10.3 Open items (accepted for now, fix before the VPS)
- Engine listeners are bound to all interfaces (from the seed): on Railway only the gateway's port is public,
  but other services on the private network could reach the engine's port 8080. Bind them to 127.0.0.1 when
  moving to the VPS.
- The seed dump contains private keys besides DKIM (likely the engine's TLS key and a server secret): regenerate
  them on the VPS.
- Container runs as root; Node is installed with the NodeSource script (semgrep warning); built-in Postgres uses
  `trust` (only when `DATABASE_URL` is unset).
- VPS compose files serve HTTP without TLS and allow clear-text mail auth; default DB password in `deploy/`.
- `ADMIN_TOKEN` is both a server secret and the encryption-key source; a separate key would be cleaner.
- Per-mailbox brake (30 failures) can be used to lock someone out for 15 minutes.
- OpenSearch is reached with certificate checks off (self-signed, private network, password-protected).

---

## 11. Engine facts worth knowing (Stalwart 0.16.23)
- Management objects over JMAP: `x:Domain`, `x:Account` (User/Group), `x:DkimSignature` (stages pending,
  active, retiring, retired), `x:DataRetention`, `x:Role`, `x:ApiKey`, `x:AppPassword`, `x:AccountPassword`.
- Group accounts are shared mailboxes; members see them as extra JMAP accounts and get the group identity.
- Custom keywords (`label:…`, `assigned:…`) are kept and searchable.
- Basic auth returns 402 when two-step is on; codes are checked via `/api/auth` + `/auth/token`.
- The engine doesn't check the first two-step code and accepts a code repeatedly within its window (the
  gateway handles both). App passwords skip two-step; max 5 per account.
- An account can only grant permissions it holds itself (effective permissions).
- `STALWART_RECOVERY_ADMIN` creates a full admin login from the environment; `CONFIG_PATH` breaks `-i` imports.
- Domains ending in `.example` are refused.

---

## 12. Roadmap
1. Deploy Phases 2, 3a, 3b + audit fixes + English/French; do the actions in §10.2.
   Next in development: sign-up for name@iron-id.io (switched off in production until the VPS and the
   iron-id.io MX move), then connecting your own domain from the webmail (design: project doc
   `signup-and-languages-plan-2026-10-15`).
2. VPS (OVH, port 25 open): move the engine and its database, clean IP + reverse DNS, TLS on mail ports,
   listeners bound correctly, fresh keys; pilot on `mail.iron-id.io`.
3. Mail apps (IMAP/SMTP submission), spam/virus filtering, deliverability monitoring, verified-sender badge.
4. Workspace integration (shared accounts, Storage attachments), payment collection.
