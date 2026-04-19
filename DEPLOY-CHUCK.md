# DEPLOY-CHUCK.md — Chuck's instance cutover checklist

This doc describes the exact steps to stand up Chuck's public-facing EddzHealth instance on `chuckshealth.axis.vorignet.com`. Most pieces are already prepared (systemd unit installed, nginx config written); this file captures the cutover sequence and the pfSense config that can't be automated.

## Pre-cutover state (already done by v2-redesign branch)

- ✅ System user `chuckshealth` exists (no shell, home at `/home/chuckshealth`)
- ✅ `$HEALTH_HOME = /home/chuckshealth/health/` skeleton created (0700, owned by chuckshealth)
- ✅ Shared code at `/opt/eddzhealth/` (root-owned, world-readable)
- ✅ Env file at `/etc/eddzhealth-chuckshealth.env` (0600, root-owned)
- ✅ systemd unit `/etc/systemd/system/chuckshealth.service` (disabled)
- ✅ nginx config `/etc/nginx/sites-available/chuckshealth.conf` (symlinked into sites-enabled, NOT reloaded)
- ❌ Onyx gateway token rotation (blocking — placeholder in env file)
- ❌ pfSense NAT + DNS override
- ❌ fail2ban (not installed system-wide)
- ❌ Chuck's data migration run
- ❌ Invite issued

## Cutover sequence (at M11)

### 1. Rotate Onyx's gateway token

```bash
# Inside the onyx container:
docker exec -it onyx bash
# In the container, edit /home/onyx/.chat-gateway/chat-gateway.json:
#   gateway.auth.token: "<new-strong-token>"
# Restart Onyx:
exit
docker compose -f /home/minecraft/onyx/docker-compose.yml restart onyx
```

Then update `/etc/eddzhealth-chuckshealth.env`:

```
CHAT_GATEWAY_TOKEN=<new-strong-token>
CHAT_GATEWAY_MODEL=<whatever-onyx-uses>
```

(Get the model name via `docker exec onyx cat /home/onyx/.chat-gateway/chat-gateway.json | jq .gateway` — look at the default model Onyx is configured for.)

### 2. Run Chuck's data migration

The Chuck data migration is in `scripts/migrate-chuck-md-to-json.js` (landed in M9). Run it from `/opt/eddzhealth`:

```bash
sudo -u chuckshealth HEALTH_HOME=/home/chuckshealth/health \
  node /opt/eddzhealth/scripts/migrate-chuck-md-to-json.js --apply
```

### 3. Sync /opt/eddzhealth with latest code

After the v2-redesign branch is merged + you deploy to `/opt/eddzhealth`:

```bash
sudo rsync -a --exclude='node_modules' --exclude='.git' \
    --delete \
    /home/minecraft/axis/workspace/.private/health/webapp/ /opt/eddzhealth/
cd /opt/eddzhealth && sudo npm install --omit=dev
sudo chmod -R a+rX /opt/eddzhealth
```

### 4. Start Chuck's service

```bash
sudo systemctl enable chuckshealth
sudo systemctl start chuckshealth
sudo systemctl status chuckshealth --no-pager
sudo journalctl -u chuckshealth -n 50 --no-pager
```

Expect: "Health dashboard running at http://127.0.0.1:10005" + "[manifest] loaded N card(s)".

### 5. Reload nginx

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Confirm DNS

```bash
# Local LAN resolution (should point at vorcraft's LAN IP):
dig chuckshealth.axis.vorignet.com +short

# External resolution (should point at the public IP):
dig @8.8.8.8 chuckshealth.axis.vorignet.com +short
```

If split-horizon isn't in place yet, set it up on pfSense (see below).

### 7. pfSense configuration

pfSense can't be scripted from this doc; follow these click-through steps:

#### Port forward (WAN → vorcraft)

If you don't already forward 80+443 from WAN → vorcraft, add two NAT rules:

- **Services → NAT → Port Forward → Add**
  - Interface: `WAN`
  - Protocol: `TCP`
  - Source: `any`
  - Destination: `WAN address`
  - Destination port range: `HTTP` (80)
  - Redirect target IP: `<vorcraft LAN IP>`
  - Redirect target port: `80`
  - Description: "HTTP to vorcraft for LE + redirect"
- Repeat for HTTPS (443 → 443)

pfSense auto-creates the WAN firewall rule to allow each forward.

#### DNS Resolver host override (LAN split-horizon)

So LAN clients resolve `chuckshealth.axis.vorignet.com` → vorcraft's LAN IP (not the public IP, which would require hairpin NAT):

- **Services → DNS Resolver → Host Overrides → Add**
  - Host: `chuckshealth`
  - Domain: `axis.vorignet.com`
  - IP Address: `<vorcraft LAN IP>`
  - Description: "LAN split-horizon for chuckshealth"

Apply. Flush LAN DNS caches if needed.

### 8. fail2ban (optional but recommended for a public-facing instance)

Not installed by default. To enable:

```bash
sudo apt-get update
sudo apt-get install fail2ban
sudo systemctl enable --now fail2ban
```

Then create the jail:

```bash
sudo tee /etc/fail2ban/jail.d/chuckshealth.conf > /dev/null <<'EOF'
[chuckshealth-auth]
enabled = true
filter  = chuckshealth-auth
logpath = /var/log/nginx/access.log
maxretry = 4
findtime = 600
bantime  = 86400
action   = iptables-multiport[name=chuckshealth-auth, port="http,https"]
EOF

sudo tee /etc/fail2ban/filter.d/chuckshealth-auth.conf > /dev/null <<'EOF'
[Definition]
# Match 4xx on /auth/register/verify specifically (failed registrations).
# Adjust if your access log format differs.
failregex = ^<HOST> .* "POST /auth/register/verify HTTP/[0-9.]+" 4\d\d
            ^<HOST> .* "POST /auth/login/verify HTTP/[0-9.]+" 4\d\d
ignoreregex =
EOF

sudo systemctl restart fail2ban
sudo fail2ban-client status chuckshealth-auth
```

### 9. Issue Chuck's first invite

From `/opt/eddzhealth` (or run the CLI directly):

```bash
sudo HEALTH_HOME=/home/chuckshealth/health \
  HEALTH_ORIGIN=https://chuckshealth.axis.vorignet.com \
  node /opt/eddzhealth/scripts/invite.js --label chuck
```

Output includes the share URL. Send to Chuck via Signal/Discord/whatever.

### 10. Walk Chuck through registration

He opens the URL on his Samsung phone → taps "Register Passkey" → fingerprint confirmation → lands on dashboard. One-tap subsequent logins.

If he needs the laptop too, issue a second invite (single-use, per-device).

## Rollback

1. `sudo systemctl stop chuckshealth` — process down
2. `sudo rm /etc/nginx/sites-enabled/chuckshealth.conf && sudo systemctl reload nginx` — public entry point gone
3. pfSense: disable the NAT rules for 80/443 (or remove chuckshealth from the host override so it no longer resolves)
4. Restore data if needed: `sudo cp -r /home/chuckshealth/health/data/_archive/migration-*/ /home/chuckshealth/health/data/` (reverses M9)

## Security posture (summary)

| Layer | Control |
|---|---|
| Network | pfSense WAN-only allow 80/443 → vorcraft; split-horizon DNS for LAN |
| TLS | Wildcard cert `*.axis.vorignet.com` via acme.sh (DNS-01 renewal) |
| HTTP | nginx with HSTS, strict CSP, X-Frame-Options, Referrer-Policy, rate limits |
| Auth | WebAuthn passkey + single-use invite codes; RP_ID narrowed to `chuckshealth.axis.vorignet.com`; stricter UV=required |
| Transport to backend | nginx → 127.0.0.1:10005 loopback only (backend not bound to 0.0.0.0) |
| Service user | `chuckshealth` — no shell, no home write outside health dir, no system perms |
| Systemd | ProtectSystem=strict, ProtectHome=read-only, PrivateTmp, PrivateDevices, etc. |
| Data | `$HEALTH_HOME` 0700, env file 0600, config.json 0600 |
| Chat | `CHAT_GATEWAY_TOKEN` in systemd env file (0600, root-owned), not in code |
| Logging | fail2ban jails 4xx on `/auth/*/verify`, 24-hour bans |
