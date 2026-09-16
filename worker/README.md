# Polymarket relay (Cloudflare Worker)

Makes the dashboard genuinely live, from any network.

## Why

The dashboard is static, so every request comes from the visitor's browser. That
fails wherever `polymarket.com` cannot be resolved — several Indian ISPs return
one unreachable address for the whole zone. GitHub Actions was the first
workaround, but a cron is not "live": GitHub throttles high-frequency schedules
on free public repos, and the measured gap between runs was **245 minutes**.

This Worker sits in between. The browser talks to it; it talks to Polymarket.

## Deploy (about 2 minutes)

```bash
cd worker
npx wrangler login      # opens your browser, one time
npx wrangler deploy
```

Wrangler prints a URL like `https://polymarket-relay.<you>.workers.dev`.

Then open the dashboard and paste that URL into the **Relay** box in the header.
It is remembered in your browser (`localStorage`), so you only do this once.
You can also pass it as `?relay=https://...` to share a working link.

## Endpoints

| | |
|---|---|
| `GET /ws` | WebSocket upgrade → pipes Polymarket's global activity feed. Auto-subscribes, so the page just connects. ~28 fills/sec. |
| `GET /api/data/v2/leaderboard?...` | REST passthrough. Hosts: `data`, `gamma`, `clob`. |
| `GET /health` | Liveness check. |

## The cache trick

Every Polymarket REST response is CDN-cached `max-age=300`, so polling faster
than 5 minutes normally returns identical bytes. The proxy appends a nonce
(`_=<time>`). Polymarket **ignores unknown query params** — verified, a bogus
one still returns a normal 200 — but CloudFront keys its cache on the full URL,
so the nonce forces a cache miss and a genuinely fresh response.

## Cost

Free tier: 100,000 requests/day. A WebSocket connection counts as one request
regardless of how many messages flow through it, so ordinary use is nowhere near
the limit.
