# DEMO.md: running a public Klebb demo

This document covers standing up a public, no-credentials demo of
Klebb (e.g. `demo.klebb.app`) using the official Docker image.

A demo instance behaves differently from a normal Klebb deployment:

- **No passkey login.** A single shared `demo` session is minted on
  the press of a button.
- **No invite, no setup, no settings persistence.** All write
  endpoints that would mutate auth, branding, or chat config return
  410 Gone.
- **Chat is a canned reply.** No outbound HTTP to any LLM gateway.
- **Card-hide is locked.** Visitors can't permanently hide cards.
- **An hourly reset rolls the dataset forward.** A cron job re-runs
  `scripts/reset-demo.js` against the bind-mounted data directory so
  the dashboard always looks like it was updated this week.

The demo mode is gated by a single env var: `KLEBB_DEMO=1`. A normal
production instance never sets this; the safety wiring inside
`scripts/reset-demo.js` refuses to run unless `KLEBB_DEMO=1` is set,
so the reset cron can't accidentally fire against a real instance.

## Prerequisites

- A Linux VPS with Docker Engine + the compose plugin.
- nginx + certbot in front of the container for TLS.
- A DNS record pointing at the host.

## 1. Compose file

Create `/opt/klebb-demo/compose.yml`:

```yaml
services:
  klebb-demo:
    image: ghcr.io/aristocles/klebb:2.1.2
    container_name: klebb-demo
    restart: unless-stopped
    ports:
      - '127.0.0.1:18081:10002'
    env_file: .env
    volumes:
      - ./data:/data
```

Note: GHCR tags have no `v` prefix. The publish workflow uses
`docker/metadata-action` with `type=semver,pattern={{version}}`, which
strips the `v` from the git tag before pushing. So git tag `v2.1.2`
becomes Docker tag `2.1.2`.

## 2. Environment file

Create `/opt/klebb-demo/.env` (mode 600):

```ini
KLEBB_DEMO=1
SESSION_SECRET=<long random hex string>
HEALTH_RP_ID=demo.klebb.app
HEALTH_RP_NAME=Klebb demo
HEALTH_ORIGIN=https://demo.klebb.app
```

Generate a fresh `SESSION_SECRET` with `openssl rand -hex 32`.

The container defaults `HEALTH_HOME=/data` and `PORT=10002` already,
so you don't need to set those.

## 3. nginx vhost

Create `/etc/nginx/sites-available/demo.klebb.app` (assumes you
already have a TLS cert covering the demo hostname; if not, run
`certbot --nginx --expand -d demo.klebb.app -d <other names>` first):

```nginx
server {
    listen 80;
    server_name demo.klebb.app;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name demo.klebb.app;

    ssl_certificate /etc/letsencrypt/live/<cert-name>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<cert-name>/privkey.pem;

    client_max_body_size 32M;

    location / {
        proxy_pass http://127.0.0.1:18081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/demo.klebb.app \
      /etc/nginx/sites-enabled/demo.klebb.app
nginx -t && systemctl reload nginx
```

## 4. Boot the container

```bash
cd /opt/klebb-demo
docker compose pull
docker compose up -d
docker compose logs --tail=50
```

The first boot will create `./data/` (owned by the in-container
`klebb` user, uid 1001) and seed an empty welcome card. Visit
`https://demo.klebb.app/` and click "Enter the demo" to confirm.

## 5. Seed the demo dataset

The image ships `/app/demo/fixtures/` and `/app/scripts/reset-demo.js`,
so you can seed straight from inside the running container:

```bash
docker exec --user root \
  -e KLEBB_DEMO=1 -e HEALTH_HOME=/data \
  klebb-demo node /app/scripts/reset-demo.js
```

This wipes any JSON in `/data/data/` and any markdown in
`/data/reports/`, then copies the curated fixture set over and
rewrites `__OFFSET_DAYS:N__` placeholders against today.

Verify the dashboard now shows the curated cards plus the Reports
page entries.

## 6. Hourly reset cron

Create `/usr/local/bin/klebb-demo-reset.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! docker ps --format '{{.Names}}' | grep -q '^klebb-demo$'; then
  echo "[klebb-demo-reset] container not running; skipping"
  exit 0
fi

docker exec --user root \
  -e KLEBB_DEMO=1 -e HEALTH_HOME=/data \
  klebb-demo node /app/scripts/reset-demo.js
```

```bash
chmod +x /usr/local/bin/klebb-demo-reset.sh
```

Then `/etc/cron.d/klebb-demo-reset`:

```cron
0 * * * * root /usr/local/bin/klebb-demo-reset.sh >> /var/log/klebb-demo-reset.log 2>&1
```

The cron fires at the top of every hour. Watch
`/var/log/klebb-demo-reset.log` to confirm successful runs.

## 7. Updating to a new release

```bash
cd /opt/klebb-demo
# Pin to the new tag in compose.yml first, e.g. ghcr.io/aristocles/klebb:2.1.3
docker compose pull
docker compose up -d
# Re-seed; new fixtures may have landed
docker exec --user root \
  -e KLEBB_DEMO=1 -e HEALTH_HOME=/data \
  klebb-demo node /app/scripts/reset-demo.js
```

Image tag must match the compose file. `latest` is also published but
explicit version pinning is recommended for visibility.

## Troubleshooting

| Symptom | First check |
|---|---|
| `docker compose pull` returns "unauthorized" | The GHCR package may be private. Flip it to public at `https://github.com/users/<owner>/packages/container/klebb/settings`. The image is meant to be anonymously pullable. |
| `docker compose pull` returns "tag not found" | Confirm the tag exists at `https://github.com/Aristocles/klebb/pkgs/container/klebb`. Remember the publish workflow strips the `v` prefix: git tag `v2.1.2` → image tag `2.1.2`. |
| Reset script: "Cannot find module" | The image is older than 2.1.2 and doesn't carry `demo/` or `scripts/reset-demo.js`. Pull a newer tag. |
| Reset script: "refuses to run without KLEBB_DEMO=1" | The cron is wired correctly; the `.env` for the running container does not have `KLEBB_DEMO=1`. Add it and `docker compose up -d` to recreate. |
| Visitors see the passkey prompt instead of "Enter the demo" | `KLEBB_DEMO=1` not set in the environment of the running container. Confirm with `docker inspect klebb-demo \| grep -i klebb_demo`. |
| Cards don't show fresh dates | The hourly cron isn't firing. `tail /var/log/klebb-demo-reset.log` and `systemctl status cron`. |

## What the demo does NOT do

- Issue invites or accept passkey registrations.
- Persist any visitor input across the next reset cycle.
- Make outbound HTTP for chat or voice. Chat replies with a canned
  string; voice routes return 503.
- Run any of the scheduled tasks that a normal Klebb instance does
  (no auto-export ingestion, no email, etc.).

If a behaviour you expect from the demo isn't in the above list,
treat it as a gap and file an issue.
