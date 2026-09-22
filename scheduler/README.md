# Research refresh timer

This separate Cloudflare Worker dispatches the existing GitHub Actions pipeline
every 15 minutes, without relying on GitHub's cron. It does not compute research
inside Cloudflare or make historical scores real-time. Build duration, Actions
queueing and Pages propagation add latency. Existing active runs are skipped.
GitHub's original schedule remains a fallback. Monitor failed scheduled runs in
Cloudflare observability, particularly token expiry or GitHub API errors.

Activation (not active merely because these files exist):

1. Create a fine-grained GitHub token limited to `shyameet/polymarket-lab`, with
   repository Actions read/write. No Contents write permission is needed.
2. From this directory run `npx wrangler secret put GITHUB_TOKEN` and paste the
   token into the hidden local prompt. Never put it in source, browser code or chat.
3. Run `npx wrangler deploy` and inspect a scheduled invocation plus the matching
   GitHub workflow run. Confirm its output reaches GitHub Pages.

There is no public HTTP endpoint that can trigger builds. No paid services or
storage bindings are required. Timer activation requires account authorization.
