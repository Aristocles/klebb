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
- Node.js 20 or 22
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

### Voice chat (optional)

Voice input and voice replies are supported via Fish Audio. See
[`docs/VOICE.md`](VOICE.md) for configuration and troubleshooting.

### Inbox-driven report ingest (optional)

Klebb watches `$HEALTH_HOME/inbox/` for `.pdf`, `.png`, `.jpg`,
`.txt`, `.md`, `.mp3`, `.wav`, `.m4a`, `.ogg`, and `.opus` drops and
extracts each into a markdown report under `$HEALTH_HOME/reports/`.
The chat agent picks them up via the `read_report` tool.

System packages required for bare-metal deploys (the published Docker
image ships with all four baked in):

- `poppler-utils` (provides `pdftotext` for PDF extraction)
- `tesseract-ocr` + `tesseract-ocr-eng` (image OCR)
- `ffmpeg` (already required for voice; reused for audio ingest)

```bash
sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng ffmpeg
```

Audio ingest reuses `FISH_AUDIO_API_KEY`: drops without it land in
`$HEALTH_HOME/inbox/_failed/` with an explanatory `.error` sibling.
PDF / image / text drops work without any chat or voice key set.

See [`REPORTS.md`](REPORTS.md) for the full workflow, output format,
and troubleshooting checklist.

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
