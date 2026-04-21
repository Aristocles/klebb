# DEPLOY.md — Running an EddzHealth instance

This document walks through standing up an EddzHealth instance on a Linux
server. It covers:

1. Single-user deploy (you, on your own box)
2. Multi-user / public-facing deploy (multiple instances, one per user)
3. Development quickstart
4. Troubleshooting

The approach is intentionally lightweight: Node.js + systemd + nginx.
No Docker, no build step, no CI dependencies.

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
git clone https://github.com/makeitbreakitfixit/eddzhealth.git /opt/eddzhealth
cd /opt/eddzhealth
npm install --omit=dev
```

### Create the data directory

```bash
mkdir -p ~/eddzhealth/data
# Optionally start with an example card:
cp /opt/eddzhealth/data.example/weight.example.json ~/eddzhealth/data/weight.json
```

### Environment file

Create `/etc/eddzhealth.env`:

```ini
# Paths
HEALTH_HOME=/home/you/eddzhealth

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

# Optional: chat agent (chat-gateway gateway)
# CHAT_GATEWAY_HOST=localhost
# CHAT_GATEWAY_PORT=8787
# CHAT_GATEWAY_TLS=false
# CHAT_GATEWAY_TOKEN=<bearer-token>
# CHAT_GATEWAY_MODEL=<model-id>

# Optional: server-to-server agent writes
# AGENT_API_TOKEN=<random-strong-token>

# Optional: voice chat via Fish Audio
# FISH_AUDIO_API_KEY=<key>
# FISH_AUDIO_DEFAULT_VOICE=<voice-model-id>
```

Secure it:

```bash
sudo chmod 600 /etc/eddzhealth.env
sudo chown root:root /etc/eddzhealth.env
```

### systemd unit

Create `/etc/systemd/system/eddzhealth.service`:

```ini
[Unit]
Description=EddzHealth dashboard
After=network.target

[Service]
Type=simple
User=you
Group=you
WorkingDirectory=/opt/eddzhealth
EnvironmentFile=/etc/eddzhealth.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/you/eddzhealth

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eddzhealth
sudo journalctl -u eddzhealth -f
```

Expected output:

```
Health dashboard running at http://127.0.0.1:8080
[manifest] loaded N card(s); 0 error(s)
```

### nginx reverse proxy

`/etc/nginx/sites-available/eddzhealth.conf`:

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
sudo ln -s /etc/nginx/sites-available/eddzhealth.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### First-time passkey registration

1. Visit `https://health.example.com/register` in the browser where you
   want to keep your passkey (typically iOS / macOS keychain)
2. Tap "Register Passkey", authenticate with Face ID / Touch ID
3. You're logged in; future visits go straight to the dashboard

---

## 2. Multi-user / public-facing deploy

The webapp is instance-per-user. Each user gets:

- A dedicated system user (e.g. `alice`)
- Their own `$HEALTH_HOME` (e.g. `/home/alice/health`)
- Their own systemd unit on a unique port
- Their own subdomain (e.g. `alice.health.example.com`)

The code at `/opt/eddzhealth` is shared (read-only). Per-user config is
in environment files.

### Templated systemd unit

`systemd/eddzhealth@.service` in the repo is a template unit. Install once:

```bash
sudo cp /opt/eddzhealth/systemd/eddzhealth@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Per-instance env file: `/etc/eddzhealth-<instance>.env` (e.g. `/etc/eddzhealth-alice.env`).

Enable + start a specific instance:

```bash
sudo systemctl enable --now eddzhealth@alice
sudo journalctl -u eddzhealth@alice -f
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
- Keep `AGENT_API_TOKEN` and `CHAT_GATEWAY_TOKEN` in the env file (0600, root)
- Run each instance as its own system user (no shell)

---

## 3. Development quickstart

```bash
git clone https://github.com/makeitbreakitfixit/eddzhealth.git
cd eddzhealth
npm install
export HEALTH_HOME=~/eddzhealth-dev
mkdir -p $HEALTH_HOME/data
cp data.example/weight.example.json $HEALTH_HOME/data/weight.json
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

## 4. Troubleshooting

**"No cards yet" on the dashboard.**
The `$HEALTH_HOME/data/` directory is empty. Drop a valid manifest file in
(copy from `data.example/`).

**Passkey registration fails with "WebAuthn not supported" or similar.**
Check `HEALTH_RP_ID` and `HEALTH_ORIGIN` match the URL you're visiting.
Mismatch between browser origin and server RP_ID is the #1 cause.

**Chat widget shows "Chat is not configured."**
`CHAT_GATEWAY_TOKEN` is unset or empty. Set it in the env file and restart.

**Voice doesn't work.**
`FISH_AUDIO_API_KEY` is unset or invalid. Check `/api/voice/config` in
the browser dev tools to see the error.

**Server starts but dashboard is blank.**
Look at `journalctl -u eddzhealth -n 100`. Common cause: malformed
manifest file in `$HEALTH_HOME/data/` logs a parse error but doesn't
crash the server — the offending file just doesn't produce a card.

**Migrating from a legacy (v1) install.**
Run `scripts/migrate-v1-to-v2.js` against your data directory. See the
script's `--help` for options.
