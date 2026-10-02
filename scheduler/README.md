# Paper-fund timer (optional, not deployed)

Not needed: since 2026-10-02 `.github/workflows/fund.yml` paces itself every ~15
minutes. Each run queues the next one, which waits out the 14-minute wait timer of
the `fund-timer` environment. That needs no outside service and no stored token.

This Cloudflare Worker is the alternative, kept in case a stricter clock is ever
wanted: it dispatches `fund.yml` every 15 minutes from outside GitHub and skips a
tick while a run is still active. It never dispatches the full scorecard rebuild
(`refresh.yml`): rebuilding everything every 15 minutes would add 1-2 GB of git
history a month.

Activation (only if wanted; not active merely because these files exist):

1. Create a fine-grained GitHub token limited to `shyameet/polymarket-lab`, with
   repository permission **Actions: Read and write**, and the longest expiry
   offered. No Contents permission is needed.
2. From this directory run `npx wrangler secret put GITHUB_TOKEN` and paste the
   token into the hidden local prompt (allow it to create the Worker if asked).
   Never put the token in source, browser code or chat.
3. Run `npx wrangler deploy`.

Running both would only add an occasional extra run: `fund.yml` queues at most one
successor and its replays never overlap.
