# DEPLOY.md — Running an Klebb instance

This document walks through standing up an Klebb instance on a Linux
server. It covers:

1. Single-user deploy (you, on your own box)
2. Multi-user / public-facing deploy (multiple instances, one per user)
3. Development quickstart
4. Troubleshooting

The approach is intentionally lightweight: Node.js + systemd + nginx.
No Docker, no build step, no CI dependencies.

For a **public, no-credentials demo deployment** (e.g. `demo.klebb.app`),
see [DEMO.md](DEMO.md).

---

## 1. Single-user deploy

### Prerequisites

- Linux host (Debian/Ubuntu tested)
- Node.js 22.13 or newer (the embedded card-data store uses the built-in
  `node:sqlite` module, unflagged from 22.13; the server refuses to start
  on anything older)
- nginx (or any reverse proxy; optional if binding directly)
- A DNS record pointing at your host, with TLS (recommended: Let's Encrypt
  via certbot)

### Install

```bash
# Clone the repo wherever you like — it's the running code directory.
git clone https://github.com/Aristocles/klebb.git /opt/klebb
cd /opt/klebb
npm install --omit=dev
```

### Create the data directory

```bash
mkdir -p ~/klebb/data
```

### Environment file

Create `/etc/klebb.env`:

```ini
# Paths
HEALTH_HOME=/home/you/klebb

# Branding
HEALTH_INSTANCE_NAME=My Health
CHAT_AGENT_NAME=Chat
CHAT_AGENT_EMOJI=💬

# Auth (WebAuthn) — MUST match your public URL
HEALTH_RP_ID=health.example.com
HEALTH_RP_NAME=My Health
HEALTH_ORIGIN=https://health.example.com

# Server
PORT=8080
HOST=127.0.0.1

# Timezone (IANA zone; default UTC if unset)
# Set this to your local zone if you want card dates and log
# timestamps to match your wall clock.
# TZ=Australia/Sydney

# Chat agent — strongly recommended. Klebb is LLM-first: card creation,
# editing, and most ongoing interaction flows through the chat agent.
# Without it, users are limited to hand-authoring manifest files.
# Any OpenAI-compatible chat-completions endpoint works.
CHAT_ENDPOINT_URL=https://api.openai.com/v1/chat/completions
CHAT_API_KEY=<bearer-token>
CHAT_MODEL=<model-id>

# Optional: server-to-server agent writes
# AGENT_API_TOKEN=<random-strong-token>

# Optional: voice chat via Fish Audio — see docs/VOICE.md
# FISH_AUDIO_API_KEY=<key>
# FISH_AUDIO_DEFAULT_VOICE=<voice-model-id>
```

Secure it:

```bash
sudo chmod 600 /etc/klebb.env
sudo chown root:root /etc/klebb.env
```

### systemd unit

Create `/etc/systemd/system/klebb.service`:

```ini
[Unit]
Description=Klebb dashboard
After=network.target

[Service]
Type=simple
User=you
Group=you
WorkingDirectory=/opt/klebb
EnvironmentFile=/etc/klebb.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/you/klebb

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now klebb
sudo journalctl -u klebb -f
```

Expected output:

```
Health dashboard running at http://127.0.0.1:8080
[manifest] loaded N card(s); 0 error(s)
```

### nginx reverse proxy

`/etc/nginx/sites-available/klebb.conf`:

```nginx
server {
  listen 443 ssl http2;
  server_name health.example.com;

  ssl_certificate     /etc/letsencrypt/live/health.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/health.example.com/privkey.pem;

  # Buffer-limit large JSON card manifest uploads
  client_max_body_size 2M;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
  }
}

server {
  listen 80;
  server_name health.example.com;
  return 301 https://$host$request_uri;
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/klebb.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### First-time passkey registration

1. Visit `https://health.example.com/register` in the browser where you
   want to keep your passkey (typically iOS / macOS keychain)
2. Tap "Register Passkey", authenticate with Face ID / Touch ID
3. You're logged in; future visits go straight to the dashboard

### Managing passkeys

Once you're signed in, **Settings → Security** lists your passkeys and
lets you add another device or remove one, no shell required. Adding a
passkey from a live session never needs an invite code.

From the command line:

- `npm run list` shows each passkey with its nickname, device type, and
  when it was registered / last used.
- `npm run revoke -- --label <name>` removes a whole label's passkeys.
  It refuses to remove the last remaining credential (that would empty
  the store and re-open first-run registration to any visitor).
- From an authenticated session the app exposes `GET /api/credentials`
  (list) and `DELETE /api/credentials/:id` (remove one by id, same
  last-credential guard). Deleting a passkey also ends any live session
  bound to that device.

Upgrading an existing install: run `npm run migrate-credential-fields`
once to backfill the per-passkey `nickname` and `lastUsedAt` fields
(idempotent; takes a timestamped backup first).

### Voice chat (optional)

Voice input and voice replies are supported via Fish Audio. See
[`docs/VOICE.md`](VOICE.md) for configuration and troubleshooting.

### Report uploads

Users upload documents from the Reports page: PDFs, photos of lab
results, scans, `.docx` letters, `.txt` / `.md` / `.csv`, and audio.
Klebb extracts the text locally, then produces a summary through the
configured chat gateway, and the agent reads them via `read_report`.

System packages required for bare-metal deploys (the published Docker
image ships all of them):

- `poppler-utils` (`pdftotext` for a PDF's text layer, plus `pdftoppm`
  and `pdfinfo`, which rasterise scanned PDFs so they can be OCRed)
- `tesseract-ocr` + `tesseract-ocr-eng` (OCR for photos and scans)
- `ffmpeg` (already required for voice; reused for audio)

```bash
sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng ffmpeg
```

Audio reuses `FISH_AUDIO_API_KEY`; without it, audio uploads fail with
an explanatory reason shown on the Reports page. Everything else works
with no key at all, though without a reachable `CHAT_ENDPOINT_URL` a
report lands unsummarised (its extracted text is still complete and
readable).

`KLEBB_REPORTS_MAX` caps how many uploaded reports an instance holds,
defaulting to 20. It is a cost and context bound rather than a disk
one: each report is one gateway call on arrival and one entry in the
agent's prompt every turn thereafter. Raise it if you run your own
gateway.

A file placed directly into `$HEALTH_HOME/inbox/` is picked up on the
next restart, under the same cap. That is an operator door for bulk
seeding and for recovering a crash mid-read, not a second ingest path.

See [`REPORTS.md`](REPORTS.md) for the report states, the OCR
verification loop, the privacy boundary, and troubleshooting.

---

## 2. Multi-user / public-facing deploy

The webapp is instance-per-user. Each user gets:

- A dedicated system user (e.g. `alice`)
- Their own `$HEALTH_HOME` (e.g. `/home/alice/health`)
- Their own systemd unit on a unique port
- Their own subdomain (e.g. `alice.health.example.com`)

The code at `/opt/klebb` is shared (read-only). Per-user config is
in environment files.

### Templated systemd unit

`systemd/klebb@.service` in the repo is a template unit. Install once:

```bash
sudo cp /opt/klebb/systemd/klebb@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Per-instance env file: `/etc/klebb-<instance>.env` (e.g. `/etc/klebb-alice.env`).

Enable + start a specific instance:

```bash
sudo systemctl enable --now klebb@alice
sudo journalctl -u klebb@alice -f
```

The `%i` placeholder in the unit expands to the instance name.

### nginx virtual host per instance

Same pattern as the single-user deploy, but one `server { ... }` block per
instance, each pointing at its unique port.

### Hardening for public-facing instances

- Put every instance behind nginx with rate limits (e.g.
  `limit_req_zone` 10 req/s per IP)
- Use `fail2ban` on the nginx access log to ban IPs that repeatedly
  trigger WebAuthn failures
- Set `HEALTH_HOME` to a per-user directory with 0700 perms, owned by
  the instance user
- Keep `AGENT_API_TOKEN` and `CHAT_API_KEY` in the env file (0600, root)
- Run each instance as its own system user (no shell)

### Hosted instances and the control-plane API

For hosted deployments (one instance per customer, each on its own
subdomain) a separate control plane can help onboard and recover users
over HTTP, without touching the credential file directly. Two env vars
opt an instance into this:

- `KLEBB_CLOUD=1` closes open first-run bootstrap. A fresh instance on a
  public subdomain will **not** let the first visitor claim it; instead
  `/register` reports it is awaiting an emailed setup link. Self-hosted
  installs leave this unset and keep first-visitor bootstrap (the
  register URL is printed to the logs on first boot).
- `KLEBB_ADMIN_TOKEN=<secret>` enables the control-plane API. Keep it in
  the env file (0600), distinct from `AGENT_API_TOKEN` (least privilege:
  that token writes cards; this one manages access). Unset = the admin
  endpoints are disabled.

The control plane calls these server-to-server with
`Authorization: Bearer $KLEBB_ADMIN_TOKEN`:

- `GET /api/admin/health` returns a readiness snapshot:
  `{ ok, setup, cloud, rpId, origin, credentialCount }`. A provisioner
  should poll this after starting a container and check `rpId`/`origin`
  match the customer's subdomain before emailing a register link (a
  wrong RP_ID silently produces unusable passkeys); `setup` flips to
  true once the first passkey is registered.
- `GET /api/admin/credentials` lists the instance's passkeys (read-only,
  no public keys).
- `POST /api/admin/invites` (body `{ "label": "...", "expiresInDays": 3 }`)
  mints a single-use invite and returns a `registerUrl` on the
  instance's own origin (`HEALTH_ORIGIN`). Email that link to the user;
  the endpoint does not send mail itself. This covers both first-run
  onboarding and recovery when a user has lost every device.

  **Label contract:** credentials are stored per label, and a
  registration appends to the entry whose label matches the invite's.
  Recovery invites MUST reuse the original registration's label (both
  sides default to `user`); minting under a different label creates a
  separate user entry with its own credential list instead of restoring
  access to the existing one.

There is deliberately **no admin delete**: removing a passkey stays
in-app (Settings → Security), so a compromised control plane can enrol a
visible new device but can never lock a user out.

Treat this section as a **versioned contract**: hosting stacks consume
the published container image and pin these endpoints with their own
contract tests (including weekly runs against `:main`). Changing an
`/api/admin/*` response shape or the `KLEBB_CLOUD` gating behaviour is a
breaking change for them; see `docs/TESTING.md` ("Downstream consumers").

---

## 3. Automated deploys with scripts/deploy.sh

For repeated deploys (e.g. after every change), use the built-in deploy
script.

### Layout it assumes

The script uses a `releases/` + `current` symlink pattern:

```
/opt/klebb/
├── releases/
│   ├── 2026-04-21T100000Z/      ← release 1
│   ├── 2026-04-21T130000Z/      ← release 2
│   └── 2026-04-21T180000Z/      ← release 3 (current)
└── current → releases/2026-04-21T180000Z   (symlink)
```

The templated systemd unit (`klebb@.service`) has
`WorkingDirectory=/opt/klebb/current`, so flipping the symlink is enough
to change what's running.

### One-line deploy

```bash
./scripts/deploy.sh --instance alice
```

What it does:
1. Runs `npm test` locally. Bails if any test fails.
2. Rsyncs the working copy (excluding `.git`, `node_modules`, `tests/`,
   `.private/`) to a new `releases/<timestamp>/` directory.
3. Runs `npm install --omit=dev` in the new release.
4. Flips `current` symlink to the new release.
5. Restarts `klebb@<instance>.service`.
6. Smokes the health endpoint; rolls back if it fails.
7. Prunes old releases (keeps the most recent 5).

### Dry-run first

```bash
./scripts/deploy.sh --instance alice --dry-run
```

Reports every step without making changes. Run this before the first
real deploy to a new host.

### Rollback

If a deploy succeeds but you realise later that it's broken, swap the
symlink manually:

```bash
ls -t /opt/klebb/releases/     # find an earlier release
sudo ln -sfn /opt/klebb/releases/<earlier>/ /opt/klebb/current
sudo systemctl restart klebb@alice
```

Takes about 2 seconds.

### Environment overrides

```bash
DEPLOY_ROOT=/custom/path ./scripts/deploy.sh --instance test
KEEP_RELEASES=10 ./scripts/deploy.sh --instance alice
SMOKE_URL=https://klebb.example.com/auth/status ./scripts/deploy.sh --instance alice
```

### Pre-flight

Before your first deploy, run:

```bash
./scripts/verify-install.sh --health-home /home/alice/klebb-data
```

It reports on the install state (directory perms, card file shapes,
legacy schema lingering, etc.) without making changes. Exit code 0
means healthy; 1 means issues were found.

## 4. Development quickstart

```bash
git clone https://github.com/Aristocles/klebb.git
cd klebb
npm install
export HEALTH_HOME=~/klebb-dev
mkdir -p $HEALTH_HOME/data
npm start
# open http://localhost:8080
```

For local testing with WebAuthn, `HEALTH_RP_ID=localhost` and
`HEALTH_ORIGIN=http://localhost:8080` work out of the box.

Run the test suite:

```bash
npm test
```

---

## 5. Troubleshooting

**"No cards yet" on the dashboard.**
The `$HEALTH_HOME/data/` directory is empty. Drop a valid manifest file in;
see `docs/CARDS.md` for the authoring guide and `MANIFEST-SCHEMA.md` for
the full schema.

**Passkey registration fails with "WebAuthn not supported" or similar.**
Check `HEALTH_RP_ID` and `HEALTH_ORIGIN` match the URL you're visiting.
Mismatch between browser origin and server RP_ID is the #1 cause.

**Chat widget shows "Chat is not configured."**
`CHAT_ENDPOINT_URL` or `CHAT_API_KEY` is unset. Set both in the env file and restart.

**Chat times out and the journal is silent.**
Set `HEALTH_DEBUG=1` and restart. The `/api/chat` path then emits
structured `[chat:<reqId>]` lines for request entry, each agent-loop
iteration (with gateway latency), each tool dispatch (with manifest id
and duration), and the final outcome — visible in `journalctl -u
klebb@<instance>` or `docker compose logs klebb`. Structural facts
only; no prompt or reply bodies are logged.

**Voice doesn't work.**
See [`docs/VOICE.md`](VOICE.md) for Fish Audio configuration and the
full troubleshooting list.

**Server starts but dashboard is blank.**
Look at `journalctl -u klebb -n 100`. Common cause: malformed
manifest file in `$HEALTH_HOME/data/` logs a parse error but doesn't
crash the server — the offending file just doesn't produce a card.

**Migrating from a legacy (v1) install.**
Run `scripts/migrate-v1-to-v2.js` against your data directory. See the
script's `--help` for options.

## 6. Backup and sensitive files

Everything an instance needs lives under `$HEALTH_HOME/`. A snapshot
of that directory is a complete backup. The whole tree is sensitive,
but a few files inside it are particularly so and should be treated
with extra care if you ever build an export or share-debug-info
feature on top of Klebb:

| Path | What's in it |
|---|---|
| `$HEALTH_HOME/credentials/webauthn.json` | WebAuthn credential public keys + sign counters. |
| `$HEALTH_HOME/sessions/webauthn.json` | Active session tokens. Long-lived. |
| `$HEALTH_HOME/sessions/secret.key` | Session-cookie HMAC key. Rotate by deleting + restarting (forces re-login on every device). |
| `$HEALTH_HOME/keys/vapid.json` | Web Push VAPID keypair. Operator rotation: delete the file and restart; every existing device re-subscribes via Settings > Notifications on its next visit. |
| `$HEALTH_HOME/push-subscriptions.json` | Per-device push endpoints. Each row is a capability: anyone holding the endpoint URL + the configured VAPID private key can deliver a push to that device. |
| `$HEALTH_HOME/notifications.state.json` | Per-item toggle state, last-fired timestamps, quiet-hours, pause deadline, recent-fires audit ring. |
| `$HEALTH_HOME/user.json` | User preferences (currently the IANA timezone). |
| `$HEALTH_HOME/data/*.json` | Health card manifests (meta only). Each file describes a card; the logged data lives in the datastore below. |
| `$HEALTH_HOME/db/klebb.db` | Embedded SQLite store holding every card's logged data rows (plus `-wal`/`-shm` sidecars while the server runs). This is where the numbers live now, not the manifest files. |
| `$HEALTH_HOME/reports/` | Markdown reports (rendered + ingested). |
| `$HEALTH_HOME/chat/history.json` | Chat transcript with the agent. |

**Back up the whole `$HEALTH_HOME/` tree.** Don't try to be clever
about which files to skip; every one of them is needed to bring a new
instance up identically to the old one. A snapshot of the directory is
still a complete backup: the card-data store lives inside it at `db/`.

**Backing up `db/` while the server runs:** the store runs in WAL mode,
so recent writes may sit in the `klebb.db-wal` sidecar rather than the
main `klebb.db` file. A raw copy of `klebb.db` alone can miss them. Copy
the whole `db/` directory together (main file plus `-wal`/`-shm`), or
stop the server / take the snapshot at rest. The blessed portable path
is the portable export below, which materialises card files with their
data re-embedded so a copy round-trips cleanly regardless of WAL state.

### Portable export

```bash
npm run export -- /path/to/export-dir
# or directly:
node scripts/export-embed.js /path/to/export-dir
```

Writes a portable copy of the instance: every card manifest with its
`data` block re-embedded from the datastore, non-card data files
(`info/`, `auto-export/` state), `reports/`, and `config.json`. Drop the
tree into a fresh `$HEALTH_HOME`, start the server, and the boot import
ingests each card's data block: drop a file, a card appears, with its
history.

What it deliberately leaves out:

- `credentials/`, `sessions/`, `keys/`, `push-subscriptions.json`,
  `notifications.state.json` and `db/` are never copied. The exported
  card files carry the data, so the raw DB isn't needed, and a fresh
  instance mints its own auth state.
- HAE push history lives in `db/`, which is never copied, so it is
  written out separately as `data/auto-export/samples.json`: the same
  payload shape the ingest endpoint accepts. A fresh instance imports
  it on first boot (and renames it aside afterwards), so a restored
  tree keeps its full sample history, including metrics that have no
  card yet.
- The HAE ingest token and invite codes are stripped from the exported
  `config.json`. Pass `--include-secrets` to keep them (for a personal
  full-fidelity copy, not for sharing).
- Any `data/auto-export/raw/` or `raw.migrated-*/` directory left over
  from before the samples table is skipped: it is superseded duplicate
  data, often hundreds of megabytes. The `--include-raw` flag is still
  accepted so existing invocations don't fail, but it no longer does
  anything.

The target directory must be empty (or absent), and safe from being
swept into the export itself: the script refuses a target inside
`$HEALTH_HOME/data/`.

Every export also carries a provenance manifest, `klebb-export.json`,
written into the tree root after every other file (so a tree without one
is a torn export). The full tree contract, the manifest schema, and the
rules for anything that reads an exported tree are documented in
[EXPORT-FORMAT.md](EXPORT-FORMAT.md).

**Never include any of the credentials/sessions/keys/push-subscriptions
files in a user-facing export.** If you build an "export my data"
feature on top of Klebb, use `scripts/export-embed.js` or mirror its
exclusions. The `notifications.state.json` ring buffer also leaks
subscription ids and recent fire metadata, so exclude it.
