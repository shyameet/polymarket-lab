# Paper-fund timer

This separate Cloudflare Worker dispatches the paper-fund job
(`.github/workflows/fund.yml`) every 15 minutes, without relying on GitHub's
cron, which fires every few hours at best. The job replays the whales' trades
since its last run (about a minute), so the Paper fund page is never more than
roughly 25 minutes behind: up to 15 minutes to the next tick, about a minute of
replay, and a 10-minute safety lag on the newest trades, plus Pages publishing.
A run still in progress is never doubled up. GitHub's own schedules stay as a
fallback, so if the timer stops (an expired token, say) the page keeps updating,
just every few hours again.

It does not dispatch the full scorecard rebuild (`refresh.yml`): rebuilding
everything every 15 minutes would add 1-2 GB of git history a month.

Activation (not active merely because these files exist):

1. Create a fine-grained GitHub token limited to `shyameet/polymarket-lab`, with
   repository permission **Actions: Read and write**, and the longest expiry
   offered. No Contents permission is needed.
2. From this directory run `npx wrangler secret put GITHUB_TOKEN` and paste the
   token into the hidden local prompt (allow it to create the Worker if asked).
   Never put the token in source, browser code or chat.
3. Run `npx wrangler deploy`. Within 15 minutes a "Paper funds" run should appear
   under the repository's Actions tab with the event `workflow_dispatch`.

There is no public HTTP endpoint that can trigger runs. No paid services or
storage bindings are required. Failed ticks (token expiry, GitHub API errors)
show in the Worker's logs in the Cloudflare dashboard.
