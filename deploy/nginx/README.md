# Nginx deployment for the World Cup 2026 API (Cloudflare-fronted)

This directory contains a production-ready Nginx site config for the
Express app managed by PM2 in `ecosystem.config.cjs`. TLS is terminated
upstream by **Cloudflare** — the origin only listens on plain HTTP/80.

## Files

| File | Purpose |
| ---- | ------- |
| `worldcup2026.conf` | HTTP-only site config with Cloudflare IP allowlist + real-IP restoration. |

## Prerequisites

1. **Node app running locally** — PM2 should be listening on `127.0.0.1:3050`
   (matches `PORT` in `config/env.js` / `ecosystem.config.cjs`).
2. **Domain** (the config uses `api.example.com` — replace it before
   deploying).
3. **Firewall** open on `80` only (443 is closed; Cloudflare talks HTTP
   to the origin on port 80 — that's the "Full SSL (flexible)" mode).

```bash
sudo ufw allow 'Nginx HTTP'   # opens 80 only
```

## Install on Ubuntu

```bash
# 1. Install Nginx (no certbot — Cloudflare handles TLS)
sudo apt update
sudo apt install -y nginx

# 2. Drop the config in
sudo cp deploy/nginx/worldcup2026.conf \
        /etc/nginx/sites-available/worldcup2026.conf

# 3. Replace placeholder domain
sudo sed -i 's/api\.example\.com/api.your-domain.com/g' \
        /etc/nginx/sites-available/worldcup2026.conf

# 4. Enable it (and disable the default site so our :80 default_server wins)
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/worldcup2026.conf \
            /etc/nginx/sites-enabled/worldcup2026.conf

# 5. Validate + reload
sudo nginx -t
sudo systemctl reload nginx
```

## Cloudflare-side settings

In the Cloudflare dashboard for your domain:

| Setting | Recommended value |
| ------- | ----------------- |
| SSL/TLS mode | **Full** (recommended) or **Flexible** |
| Always Use HTTPS | **On** (Cloudflare forces the redirect) |
| HTTP/2 / HTTP/3 | **On** |
| WebSockets | **On** (cheap to leave enabled) |
| Browser Integrity Check | **On** |
| Bot Fight Mode | Your call — leave On for the public API |
| DNS record | `api` `A` `your.server.ip` **Proxied** (orange cloud) |

> ⚠️ Avoid "Full (Strict)" unless you've also put a real cert on the
> origin — that's overkill since Cloudflare is your TLS terminator.

## What the config does

- **Plain HTTP on port 80** — `default_server` so any direct hit on the
  origin IP that isn't from a Cloudflare IP is caught.
- **Cloudflare IP allowlist** — `if ($http_cf_ray = "") { return 403; }`
  rejects requests that bypass Cloudflare's proxy entirely (an attacker
  who discovers the origin IP can't reach the API).
- **Real-IP restoration** — `set_real_ip_from` for every Cloudflare /16
  (v4 + v6) plus `real_ip_header CF-Connecting-IP;` so `req.ip` in
  Express (and the rate-limit zone key) reflect the actual visitor.
- **Rate limiting** (30 r/s + bursts) on `/get/` and `/donate/` to protect
  Node's event loop from a single misbehaving client.
- **Caching** for static assets, `/sitemap.xml`, `/robots.txt`, and
  public `/get/*` GETs — stale responses are served if the upstream
  hiccups.
- **Security headers** (X-Frame-Options, etc.) and `server_tokens off`.
- **Gzip** for JSON / text / SVG, so even though Express also compresses,
  the cheap path (static files) is handled at the edge.

## Smoke tests

From your laptop (browser → Cloudflare → origin):

```bash
# Should 200 — request comes via Cloudflare, CF-Ray is set
curl -i https://api.your-domain.com/get/groups

# Should 403 — direct hit to origin IP, no CF-Ray header
curl -i http://YOUR.ORIGIN.IP/

# Rate limiter — should return 429 after the burst
hey -n 200 -c 50 https://api.your-domain.com/get/groups
```

If the first `curl https://…` works but `curl http://YOUR.ORIGIN.IP/` returns
403, the Cloudflare allowlist is doing its job.

## Operational notes

- Logs land in `/var/log/nginx/worldcup2026.{access,error}.log` and are
  rotated by the default `logrotate.d/nginx` rule.
- The cache directory `/var/cache/nginx/wc2026` is created automatically
  by Nginx on first start; if you change `proxy_cache_path`, create it
  manually with the right ownership:
  `sudo mkdir -p /var/cache/nginx/wc2026 && sudo chown www-data:www-data …`
- If you change the PM2 port, update the `upstream wc2026_api` block.
- Cloudflare periodically adds new IP ranges. Re-sync the list a couple
  of times a year:

  ```bash
  curl -s https://www.cloudflare.com/ips-v4 | sed 's/^/set_real_ip_from /;s/$/;/' > /tmp/cf-v4
  curl -s https://www.cloudflare.com/ips-v6 | sed 's/^/set_real_ip_from /;s/$/;/' > /tmp/cf-v6
  # then splice /tmp/cf-v4 and /tmp/cf-v6 into the top of worldcup2026.conf
  ```
