# IRON ID Mail on a server (VPS) — set-up kit

Everything needed for phases 1–2 of the move plan (project doc `vps-move-plan-2026-10-16`) and the
server's routine afterwards. Tested on every change by GitHub Actions (`.github/workflows/vps-kit.yml`):
the images build, the engine and gateway run as the unprivileged user `ironid` with the mail ports open,
and a backup restores.

| File | What it is |
|---|---|
| `compose.yml` | The services: `app` (the same image as Railway), `db` (PostgreSQL 16), `search` (OpenSearch), `web` (Caddy, HTTPS) |
| `Caddyfile` | HTTPS for the webmail at `WEB_HOST`; Let's Encrypt certificate renewed automatically |
| `.env.example` | Settings template → copy to `.env`, `chmod 600` |
| `move-data.sh` | Phase 2: copies Railway's database here, checks every table's row count, keeps the dump encrypted |
| `backup.sh` | Nightly encrypted database backup, 30 days kept, optional off-site copy (rclone) |
| `restore-test.sh` | Restores the newest backup into a throw-away database to prove it works |
| `renew-mail-cert.sh` | Nightly: gives the mail engine Caddy's certificate (IMAP/SMTP), restarts the app when it changed |
| `check-tls.sh` | Shows the certificate on ports 443, 993, 465, 587, 25 and fails on a built-in or expiring one |
| `lib.sh` | Helpers used by the scripts |

Nothing here changes DNS. **Issam's Namecheap mailbox is not affected by any step in this file.**

## 1. The server (once)
1. Order the VPS (plan §0). Set its **reverse DNS** to `mail.iron-id.io` in the provider's panel.
2. Check the IP on https://check.spamhaus.org and MXToolbox's blacklist check.
3. At Namecheap add only: `A mail` → the VPS IPv4. Nothing else. **No `AAAA` (IPv6) record for now**: Docker
   would pass IPv6 visitors on as its own internal address, which breaks the sign-up/sign-in limits per network
   and the mail engine's checks on incoming mail (SPF, blocklists). IPv6 can come later with `enable_ipv6` on the
   compose networks.
4. On the server (Ubuntu 24.04), as root:
   ```bash
   apt-get update && apt-get -y upgrade && apt-get -y install docker.io docker-compose-v2 git unattended-upgrades
   echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-opensearch.conf && sysctl --system
   adduser --disabled-password --gecos '' admin && usermod -aG sudo,docker admin   # your login; SSH key only
   sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && systemctl reload ssh
   ```
   Firewall at the provider (OVH "Network firewall"): allow 22 (your IP only), 25, 80, 443, 465, 587, 993; deny
   the rest. (Docker's published ports bypass `ufw`, so use the provider's firewall.)
5. Get the code and the settings:
   ```bash
   git clone https://github.com/chrf01910109/iron-id-mail.git /opt/ironid && cd /opt/ironid/deploy/vps
   cp .env.example .env && chmod 600 .env && nano .env      # WEB_HOST, ACME_EMAIL, new DB/search passwords,
                                                            # ADMIN_TOKEN = the SAME value as on Railway
   mkdir -p /etc/ironid && openssl rand -hex 32 > /etc/ironid/backup.key && chmod 600 /etc/ironid/backup.key
   ```
   **Keep a copy of `/etc/ironid/backup.key` and of `.env` somewhere safe outside the server** (password
   manager): without the key the backups can't be read.

## 2. Start empty and check (no effect on mail)
```bash
docker compose up -d --build db search app      # app builds the same image as Railway
docker compose exec -T app curl -s http://127.0.0.1:3001/healthz; echo
```
Expected: `"engine":"ok","database":"ok"` (adminAccess `missing` is normal before step 3).
This was only a trial: before the move, remove its test data (this server only, nothing real yet):
```bash
docker compose down -v
```

## 3. Move the data (planned, ~30 min, at night)
1. On Railway: stop the `iron-id-mail` service (Railway → service → Settings → stop / remove the deployment)
   so nothing changes during the copy. Copy the Postgres service's **DATABASE_PUBLIC_URL** (Railway →
   Postgres → Variables); don't paste it anywhere else.
2. Here:
   ```bash
   ./move-data.sh          # asks for the URL (hidden); stops if this database isn't empty or counts differ
   ```
3. One-time engine access for this server (same as on Railway's first set-up): put
   `STALWART_RECOVERY_ADMIN=recovery:<random>` in `.env`, then
   ```bash
   docker compose up -d app && sleep 40 && docker compose logs app | grep engine-admin
   ```
   It updates the gateway's engine role (now including the certificate permissions).
4. HTTPS: `docker compose up -d web`, wait a minute, open `https://mail.iron-id.io` — the webmail must load.
5. Mail certificate (still with the recovery admin set, so it also becomes the engine's default):
   ```bash
   ./renew-mail-cert.sh       # copies Caddy's certificate into the engine, restarts the app, checks every port
   ```
   Every line must say OK (the issuer is Let's Encrypt, not "rcgen").
6. **Remove `STALWART_RECOVERY_ADMIN` from `.env`** and run `docker compose up -d app`. Check
   `/healthz` shows `"recoveryAdminSet":false`.
7. Checks: sign in as charaf@ and anis@client.dz, read old mail; admin console → search → re-index (the
   search index is rebuilt here, not copied); from your Mac in the repo:
   `node tests/security/http-probe.js https://mail.iron-id.io` → every check passes.
8. Way back: start the Railway service again — its database was not touched.

## 4. Routine (cron, as root: `crontab -e`)
```
15 3 * * *  cd /opt/ironid/deploy/vps && ./backup.sh >> /var/log/ironid-backup.log 2>&1
40 4 * * *  cd /opt/ironid/deploy/vps && ./renew-mail-cert.sh >> /var/log/ironid-cert.log 2>&1
30 4 1 * *  cd /opt/ironid/deploy/vps && ./restore-test.sh >> /var/log/ironid-backup.log 2>&1
```
Off-site copies: install rclone, configure a remote (e.g. OVH Object Storage, another region) with
`rclone config`, and add `RCLONE_REMOTE=<remote>:<bucket>` before `./backup.sh` in the cron line. Best: a bucket
used only for this, with its own 30-day expiry rule and a key that can write but not delete; then also add
`RCLONE_PRUNE=no` (the bucket removes old copies itself, and a broken-into server can't wipe them).
The backup folder keeps 30 days, including the move's first copy (`railway-*.dump.enc`).

## 5. Updating the app later
```bash
cd /opt/ironid && git pull && cd deploy/vps && docker compose up -d --build app
```
(~30 s without web or mail connections; senders retry.) Then the probe.

## Then
Phases 3–6 of the plan (DKIM keys from the admin console's domain page, SPF with the VPS IP, sub-domain
pilot, Issam's mailbox, switching features on) — no file here is needed for them.
