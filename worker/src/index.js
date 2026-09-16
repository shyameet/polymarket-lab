/**
 * Polymarket relay — a Cloudflare Worker.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard is a static page, so every request comes from the visitor's own
 * browser. That fails on any network that cannot resolve polymarket.com — some
 * Indian ISPs now return a single unreachable address for the entire zone, so
 * the live socket never connects and REST calls time out.
 *
 * GitHub Actions was the first workaround, but a cron cannot be "live": GitHub
 * throttles and silently skips high-frequency schedules on free public repos,
 * and the observed gap between runs was 245 minutes.
 *
 * So: relay. The browser talks to this Worker, the Worker talks to Polymarket.
 * Two endpoints:
 *
 *   GET /ws       WebSocket upgrade -> opens a socket to Polymarket's activity
 *                 feed and pipes both directions. This is the real firehose,
 *                 ~28 fills/sec, sub-second.
 *
 *   GET /api/...  REST passthrough. Adds a cache-busting parameter, because
 *                 every Polymarket REST response is CDN-cached max-age=300 and
 *                 unknown query params are IGNORED by the API while still
 *                 forming part of the CDN cache key -- so a nonce misses the
 *                 cache and reaches origin without changing the response.
 */

const UPSTREAM_WS = 'wss://ws-live-data.polymarket.com';

const HOSTS = {
  data: 'https://data-api.polymarket.com',
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
};

const cors = (extra = {}) => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  ...extra,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === '/ws') return relayWebSocket(request);
    if (url.pathname.startsWith('/api/')) return proxyRest(url);

    if (url.pathname === '/health') {
      return Response.json(
        { ok: true, ws: `${url.origin}/ws`, api: `${url.origin}/api/<host>/<path>` },
        { headers: cors() },
      );
    }

    return new Response(
      'Polymarket relay.\n\n'
      + 'GET /ws                       live activity socket\n'
      + 'GET /api/data/v2/leaderboard  REST passthrough (hosts: data, gamma, clob)\n'
      + 'GET /health\n',
      { headers: cors({ 'Content-Type': 'text/plain' }) },
    );
  },
};

/** Pipe a browser WebSocket to Polymarket's activity feed. */
async function relayWebSocket(request) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426, headers: cors() });
  }

  let upstream;
  try {
    // Workers open an outbound socket by fetching with an Upgrade header and
    // reading `webSocket` off the response.
    const res = await fetch(UPSTREAM_WS.replace(/^wss:/, 'https:'), {
      headers: { Upgrade: 'websocket' },
    });
    upstream = res.webSocket;
    if (!upstream) {
      return new Response(`upstream refused upgrade (status ${res.status})`,
        { status: 502, headers: cors() });
    }
  } catch (err) {
    return new Response(`upstream connect failed: ${err}`, { status: 502, headers: cors() });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  upstream.accept();
  server.accept();

  // Subscribe immediately so a visitor does not have to know the protocol.
  // No filters = every market.
  const SUB = JSON.stringify({
    action: 'subscribe',
    subscriptions: [{ topic: 'activity', type: 'trades' }],
  });
  try { upstream.send(SUB); } catch { /* closed before we could subscribe */ }

  // Polymarket -> browser
  upstream.addEventListener('message', (e) => {
    try { server.send(e.data); } catch { /* browser gone */ }
  });
  upstream.addEventListener('close', (e) => {
    try { server.close(e.code >= 1000 && e.code <= 4999 ? e.code : 1011, e.reason); } catch {}
  });
  upstream.addEventListener('error', () => {
    try { server.close(1011, 'upstream error'); } catch {}
  });

  // browser -> Polymarket (lets the page send its own PINGs / re-subscribes)
  server.addEventListener('message', (e) => {
    try { upstream.send(e.data); } catch {}
  });
  server.addEventListener('close', () => {
    try { upstream.close(1000, 'client gone'); } catch {}
  });
  server.addEventListener('error', () => {
    try { upstream.close(1011, 'client error'); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

/** /api/<host>/<path...> -> https://<host>.polymarket.com/<path...> */
async function proxyRest(url) {
  const parts = url.pathname.replace(/^\/api\//, '').split('/');
  const host = HOSTS[parts.shift()];
  if (!host) {
    return new Response('unknown host; use data, gamma or clob',
      { status: 400, headers: cors() });
  }

  const target = new URL(host + '/' + parts.join('/'));
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  // Defeat the 5-minute CDN cache. Polymarket ignores unknown params (verified:
  // passing a bogus one returns a normal 200), but CloudFront keys on the full
  // URL -- so a nonce forces a miss and a genuinely fresh response.
  target.searchParams.set('_', Date.now().toString(36));

  try {
    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'polymarket-whale-lab-relay', Accept: 'application/json' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: cors({
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 502, headers: cors({ 'Content-Type': 'application/json' }) });
  }
}
