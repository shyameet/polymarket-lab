/* Polymarket Whale Lab — front end.
 *
 * FOUR VIEWS, in the order you'd actually use them
 *   Who to follow  the scored board: who is worth copying, in plain words
 *   Live buys      the fill tape, with a one-tap "I copied this"
 *   What they hold  every open position, and what was just exited
 *   My copies      positions YOU took, matched to the whale you copied, with a
 *                  loud warning the moment that whale gets out
 *
 * "My copies" lives entirely in localStorage. Nothing is sent anywhere, no
 * account, no keys, and no order is ever placed. It is a notebook that watches
 * the whale for you.
 *
 * DATA SOURCES, tried in order: relay (a Cloudflare Worker piping Polymarket's
 * websocket) -> direct browser websocket -> committed snapshot JSON. The header
 * always states which one is live and how old it is.
 *
 * LANGUAGE RULE: the previous two passes used quant shorthand (Net/DD,
 * concentration, edge per $) and were reported as confusing. Every number shown
 * by default now carries a plain-English label; the jargon survives only in the
 * detail drawer, where someone has explicitly asked for depth.
 */

const DIRECT_WS = 'wss://ws-live-data.polymarket.com';
const REFRESH_POLL_MS = 1000;
const RENDER_MS = 1000;
const MAX_ROWS = 100;
const DIRECT_MAX_FAILS = 3;
const COPIES_KEY = 'myCopies.v1';
const POSITION_MAX_AGE_MS = 6 * 60_000;
// Only text escaped here may be interpolated into presentation HTML.
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (txt != null) n.textContent = txt;
  return n;
};
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const state = {
  whales: [], byWallet: new Map(),
  trades: [], seenKeys: new Set(),
  positions: { open: [], recently_closed: [] }, posMeta: null,
  copies: [],
  snapshotMeta: null, meta: null,
  source: 'starting', via: 'direct', paused: false, dirty: true,
  stamps: [], directFails: 0, ws: null, backoff: 1000, pinger: null,
  view: 'whales', who: 'best', verdict: 'good', category: '', posFilter: 'all',
  tradeCategory: '', posCategory: '',
  hintShown: false, notified: new Set(),
  marketsSoon: null, marketsBucket: 'hours',
  cryptoFlows: null,
  watchlist: new Set(), watchOnly: false, insights: null, research: null,
  liveRefresh: null, holdingWallet: '',
  tapeNodes: new Map(), tapeHover: false, tapeTouchUntil: 0,
  tapeReset: false, tapeForce: false, tapeStake: 0,
};

function loadWatchlist() {
  try {
    const saved = JSON.parse(lsGet('whaleWatchlist.v1', '[]'));
    state.watchlist = new Set(Array.isArray(saved) ? saved.filter(w => typeof w === 'string'
      && /^0x[a-fA-F0-9]{40}$/.test(w)).map(w => w.toLowerCase()) : []);
  } catch { state.watchlist = new Set(); }
  state.watchOnly = lsGet('whaleWatchOnly.v1', 'false') === 'true';
}
const isWatched = wallet => state.watchlist.has((wallet || '').toLowerCase());
function refreshWatchlist() {
  const count = $('#watch-count');
  if (count) count.textContent = `${state.watchlist.size} followed`;
  // The one-click way out of an empty personal filter only matters while it's on.
  const showAll = $('#show-screened');
  if (showAll) showAll.hidden = !state.watchOnly;
  renderBoard(); state.dirty = true; state.tapeForce = true;
  if (state.view === 'positions') renderPositions();
  if (state.view === 'recap') state.recapUI?.render();
  if (state.view === 'soon') renderMarketsSoon();
  state.research?.render();
  document.querySelectorAll('button[data-watch-wallet]').forEach(b => {
    const selected = isWatched(b.dataset.watchWallet);
    b.textContent = selected ? '★ Following' : '☆ Follow';
    b.setAttribute('aria-pressed', String(selected));
  });
}
function watchButton(c) {
  const wallet = (c.wallet || '').toLowerCase();
  const button = el('button', 'btn small', isWatched(wallet) ? '★ Following' : '☆ Follow');
  button.dataset.watchWallet = wallet;
  button.setAttribute('aria-pressed', String(isWatched(wallet)));
  button.setAttribute('aria-label', `Follow ${displayName(c.name, wallet)}`);
  button.addEventListener('click', e => {
    e.stopPropagation();
    if (isWatched(wallet)) state.watchlist.delete(wallet); else state.watchlist.add(wallet);
    lsSet('whaleWatchlist.v1', JSON.stringify([...state.watchlist])); refreshWatchlist();
  });
  return button;
}

/* ─────────────────────────── format helpers ─────────────────────────── */

const money = (v, cents = false) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a < 100 || cents) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toFixed(0)}`;
};
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
// Polymarket falls back to a wallet's raw address as its own "user_name" when
// no display name is set -- and sometimes to a longer address-derived id (seen
// live: "0x477df235b7d1223f0664682ff385e62FFEDAFbb6-1771514724803", 56 chars).
// Caught on mobile both times: an unbroken string with no space for the
// browser to wrap on blows out the page width (a flex/grid item can force its
// ancestors wider than the viewport when its content has no break point).
// Deliberately loose -- "starts with 0x then a run of hex" -- rather than
// matching one exact generated shape, since a real chosen display name
// essentially never starts that way. Never trust "name" without checking.
const looksLikeAddress = (s) => /^0x[a-fA-F0-9]{6,}/.test(s || '');
const displayName = (name, wallet) =>
  (name && !looksLikeAddress(name)) ? name : short(wallet);
const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut');
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} hr`;
  return `${Math.round(s / 86400)} days`;
};
const isChurn = (t) =>
  /Up or Down|updown-\d+m/i.test(`${t.title || ''} ${t.slug || ''}`);

// Mirrors pm/feed.py's categorize() exactly -- the server tags snapshot
// trades with `category` already, but a trade arriving live over the
// websocket never touches the pipeline, so it needs the same classification
// done client-side or it would sit uncategorized (and unfilterable) until
// the next snapshot refresh picks it up. Keep these two patterns in sync.
const CAT_PATTERNS = [
  ['crypto', /up or down|bitcoin|ethereum|solana|\bbtc\b|\beth\b|crypto/i],
  ['csgo', /counter-strike|counter strike|\bcs2\b|\bcsgo\b/i],
  ['valorant', /valorant/i],
  ['esports', /league of legends|\blol\b|\bdota\b|overwatch|rocket league|\besports?\b|logitech g|blast premier|\besl\b|rainbow six/i],
  ['weather', /highest temperature|lowest temperature|rainfall|snowfall|hurricane|\bweather\b|°c\b|°f\b|degrees celsius|degrees fahrenheit/i],
  ['sports', /\bvs\.?\b|win on 20|o\/u|nba|nfl|mlb|ufc|atp|wta|premier league|match|\bfc\b/i],
  ['macro', /fed|interest rate|cpi|inflation|gdp|recession|jobs/i],
  ['politics', /trump|election|president|senate|congress|poll|nominee|war|ceasefire/i],
];
function categorizeClient(title, slug) {
  const s = `${title || ''} ${slug || ''}`;
  for (const [name, pat] of CAT_PATTERNS) {
    if (pat.test(s)) return name;
  }
  return 'other';
}
// Combo/parlay bets AND several markets into one wager; they have no single
// outcome and cannot be mirrored as one trade.
const isCombo = (t) => !t.outcome && / AND /.test(t.title || '');

// Requested explicitly: when a whale has more than one fill on the SAME
// market, that is a stronger (or more complicated -- see `mixed`) signal than
// a single isolated bet, and the plain trade-by-trade tape didn't say so.
// Reads the fuller loaded trade set, not just what's currently visible in the
// 5-minute tape window, so scaling-in over the last hour still counts.
function marketActivity(wallet, condition) {
  if (!condition) return null;
  const same = state.trades.filter((t) => t.wallet === wallet && t.condition === condition);
  if (same.length <= 1) return null;
  return { count: same.length, mixed: new Set(same.map((t) => t.outcome)).size > 1 };
}

const VERDICT_WORD = {
  CANDIDATE: 'WORTH FOLLOWING',
  WATCH: 'PROMISING',
  FRAGILE: 'RISKY',
  'NOT COPYABLE': 'AVOID',
  INSUFFICIENT: 'TOO NEW',
};
const CAT_LABEL = {
  crypto: 'Crypto', sports: 'Sports', politics: 'Politics', esports: 'Esports',
  csgo: 'CS:GO', valorant: 'Valorant',
  combos: 'Parlays', economics: 'Economics', tech: 'Tech', culture: 'Culture',
  finance: 'Finance', weather: 'Weather', mentions: 'Mentions',
  macro: 'Macro', other: '',
};

// Polymarket's own category label wins over the regex guess from market text.
const catOf = (c) => (c.lb_categories && c.lb_categories[0]) || c.category || '';

const verdictPill = (v) =>
  el('span', `v v-${v === 'NOT COPYABLE' ? 'NOT' : v}`, VERDICT_WORD[v] || v);

const marketLink = (title, slug) => {
  const a = el('a', null, title || slug || '—');
  if (slug) { a.href = `https://polymarket.com/event/${slug}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};

// Puts the market's plain name on the clipboard -- nothing is sent anywhere,
// it is just text -- so it can be pasted straight into Polymarket's own
// search instead of retyping a long title by hand.
function copyMarketBtn(title) {
  const btn = el('button', 'copytitle', '📋 Copy name');
  btn.type = 'button';
  btn.title = "Copy this market's name to paste into Polymarket's search";
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = title || '';
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // clipboard API needs a secure context/permission grant; fall back to
      // a selectable prompt so the text is still copyable by hand. prompt()
      // itself is disallowed in a few embedded contexts, so this is guarded
      // too -- an uncaught throw here would silently kill the feedback below.
      try { window.prompt('Copy this market name:', text); copied = true; }
      catch { /* both blocked -- fall through to the "couldn't copy" state */ }
    }
    btn.textContent = copied ? '✓ Copied' : "✗ Couldn't copy";
    btn.classList.add(copied ? 'copied' : 'failed');
    setTimeout(() => {
      btn.textContent = '📋 Copy name';
      btn.classList.remove('copied', 'failed');
    }, 1500);
  });
  return btn;
}

// Stable key so a copied bet can be matched back to the whale's position.
// condition_id (Polymarket's own on-chain market id) is preferred when we have
// it -- it is exact, unlike matching on slug/title text. Falls back to the old
// slug-based key for copies saved before this field existed, so nothing
// already tracked in someone's browser silently breaks.
const posKey = (wallet, slug, title, outcome, condition) => {
  const w = (wallet || '').toLowerCase();
  if (condition) return `${w}|c:${condition}|${outcome || ''}`;
  return `${w}|${slug || title || ''}|${outcome || ''}`;
};

/* ─────────────────────────── relay / source ─────────────────────────── */

const DEFAULT_RELAY = 'https://polymarket-relay.shyameet2.workers.dev';
const relayUrl = () => {
  const q = new URLSearchParams(location.search).get('relay');
  if (q) { lsSet('relay', q); return q.replace(/\/+$/, ''); }
  return (lsGet('relay', '') || DEFAULT_RELAY).replace(/\/+$/, '');
};

function setSource(kind, detail) {
  state.source = kind;
  $('#dot').className = `dot ${{ live: 'on', snapshot: 'warn', down: 'off' }[kind] || ''}`;
  $('#live-text').textContent = detail;
}

function refreshSourceLabel() {
  if (state.source === 'live') {
    setSource('live', `Trade feed live · ${(state.stamps.length / 10).toFixed(0)}/sec`);
  } else if (state.source === 'snapshot') {
    const ts = state.snapshotMeta?.newest_ts;
    setSource('snapshot', ts ? `Saved data · ${ago(ts)} old` : 'Saved data');
  }
}

/* ───────────────────────────── ingest ───────────────────────────────── */

function addTrade(raw, live) {
  const size = Number(raw.size) || 0;
  const price = Number(raw.price) || 0;
  const t = {
    ts: Number(raw.ts ?? raw.timestamp) || 0,
    wallet: (raw.wallet || raw.proxyWallet || '').toLowerCase(),
    name: raw.name || raw.pseudonym || null,
    side: raw.side, price,
    usd: raw.usd != null ? Number(raw.usd) : size * price,
    outcome: raw.outcome || '', title: raw.title || '',
    slug: raw.slug || raw.eventSlug || '',
    condition: raw.condition || raw.conditionId || '',
    asset: raw.asset || raw.asset_id || '',
    end_date: raw.end_date || '',
    category: raw.category || categorizeClient(raw.title, raw.slug),
    tx: raw.tx || raw.transactionHash || '',
    live: !!live,
  };
  if (!t.wallet || !t.side) return false;
  // Polymarket's socket carries fills with a blank title, condition and outcome
  // (seen live: sequentially named bot wallets trading $0.01 of one token).
  // With no market named there is nothing to show or copy -- they rendered as
  // `BOUGHT "?"` cards, ~19% of the unfiltered tape. A followed whale can still
  // emit one, so it still nudges that whale's holdings refresh.
  if (!t.title) { state.liveRefresh?.onTrade(t); return false; }

  const key = `${t.tx}|${t.wallet}|${t.ts}|${t.usd}`;
  if (state.seenKeys.has(key)) return false;
  state.seenKeys.add(key);
  if (state.seenKeys.size > 6000) {
    state.seenKeys = new Set([...state.seenKeys].slice(-3000));
  }

  const card = state.byWallet.get(t.wallet);
  t.verdict = card?.verdict || null;
  t.discovered = !!card?.discovered;
  if (card?.name) t.name = card.name;

  state.trades.push(t);
  if (state.trades.length > 4000) {
    state.trades.sort((a, b) => b.ts - a.ts);
    state.trades.length = 2500;
  }
  state.dirty = true;
  state.research?.observeTrade(t);
  state.liveRefresh?.onTrade(t);
  return true;
}

/* ───────────────────────────── websocket ────────────────────────────── */

function connect() {
  const relay = relayUrl();
  const url = relay ? `${relay.replace(/^http/, 'ws')}/ws` : DIRECT_WS;
  state.via = relay ? 'relay' : 'direct';

  let ws;
  try { ws = new WebSocket(url); } catch { return onWsDead(); }
  state.ws = ws;

  // A socket aimed at a sinkholed address can hang for over a minute before the
  // OS gives up. Judge it ourselves.
  const openTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch {} }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(openTimer);
    state.backoff = 1000;
    state.directFails = 0;
    if (!relay) {
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'activity', type: 'trades' }],
      }));
    }
    setSource('live', 'Trade feed connected · waiting for trades');
    $('#src-status').textContent = '';
    clearInterval(state.pinger);
    state.pinger = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send('PING'); } catch {} }
    }, 5000);
  };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = m?.payload ?? m;
      if (p && p.proxyWallet && p.side) {
        state.stamps.push(Date.now());
        // Pause holds the DISPLAY; it used to drop fills on the floor, so
        // anything a whale did while paused never reached the tape at all.
        addTrade(p, true);
      }
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => { clearTimeout(openTimer); clearInterval(state.pinger); onWsDead(); };
}

// It used to STOP after six failed connects in a row and never try again until
// a reload. Six failures take ~45 s -- a locked phone, a background tab, a network
// switch or the relay's daily quota running out all do that -- so the page sat on
// "isn't responding" long after the relay was back (seen 2026-09-24). Now it
// slows to one try every 30 s but never stops, and tries at once when the tab is
// looked at again or the network returns.
const SLOW_RETRY_MS = 30_000;
function onWsDead() {
  setSource(state.snapshotMeta ? 'snapshot' : 'down',
    state.snapshotMeta ? 'Saved data · reconnecting' : 'Disconnected · reconnecting');
  state.directFails += 1;
  const relay = relayUrl();
  const slow = state.directFails >= (relay ? DIRECT_MAX_FAILS + 3 : DIRECT_MAX_FAILS);
  if (slow) {
    state.source = 'snapshot';
    refreshSourceLabel();
    $('#src-status').textContent = relay
      ? `Can't reach the relay right now (${relay}). Retrying every 30 seconds, and straight away `
        + 'when you come back to this tab. Showing saved trades meanwhile.'
      : 'The live trade connection failed; the browser cannot tell a network block from an outage. '
        + 'Retrying every 30 seconds. Showing saved trades. A reachable relay may help.';
    if (!state.hintShown) { state.hintShown = true; $('#src-panel').hidden = false; }
  }
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(connect, slow ? SLOW_RETRY_MS : state.backoff);
  if (!slow) state.backoff = Math.min(state.backoff * 2, 15_000);
}
function reconnectNow() {
  const ws = state.ws;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.retryTimer);
  state.backoff = 1000;
  state.directFails = 0;
  connect();
}

/* ─────────────────────────── data loading ───────────────────────────── */

const snapshotVersions = new Map(), snapshotBusy = new Set();
async function snapshotJSON(path) {
  if (snapshotBusy.has(path)) return null;
  snapshotBusy.add(path);
  try {
    const requestPath = `${path}?refresh=${Date.now()}`;
    const previous = snapshotVersions.get(path);
    // Lightweight revision check: don't parse multi-megabyte JSON every second.
    if (previous) {
      const head = await fetch(requestPath, { method:'HEAD', cache:'no-store', signal:AbortSignal.timeout(8000) });
      if (!head.ok) throw new Error(`Snapshot HTTP ${head.status}`);
      const version = head.headers.get('etag') || head.headers.get('last-modified');
      if (version && version === previous) return null;
    }
    const r = await fetch(requestPath, {cache:'no-store',signal:AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error(`Snapshot HTTP ${r.status}`);
    const data = await r.json();
    const version = r.headers.get('etag') || r.headers.get('last-modified');
    if (version) snapshotVersions.set(path,version);
    return data;
  } finally { snapshotBusy.delete(path); }
}

async function loadWhales() {
  try {
    const [w, m] = await Promise.all([
      snapshotJSON('data/whales.json'),
      snapshotJSON('data/meta.json').catch(() => null),
    ]);
    if (m) state.meta = m;
    if (!w) return;
    if (!Array.isArray(w)) throw new Error('Invalid wallet snapshot');
    // Older snapshots can carry the pre-fix WATCH verdict for losing wallets.
    state.whales = w.map((c) => c.position_pnl <= 0 && c.verdict !== 'INSUFFICIENT'
      ? { ...c, verdict: 'NOT COPYABLE' } : c);
    state.byWallet = new Map(state.whales.map((c) => [(c.wallet || '').toLowerCase(), c]));
    const select = $('#holding-wallet');
    if (select) {
      select.replaceChildren(el('option', null, 'All screened whales (rotating)'));
      select.firstChild.value = '';
      for (const c of state.whales.filter(c => ['CANDIDATE','WATCH','FRAGILE'].includes(c.verdict))) {
        const o = el('option', null, displayName(c.name,c.wallet)); o.value=c.wallet; select.appendChild(o);
      }
      select.value=state.holdingWallet;
    }
    renderBoard();
    renderMethod();
  } catch (e) { console.error('whales', e); }
}

async function loadSnapshot() {
  try {
    const f = await snapshotJSON('data/whale_trades.json');
    if (!f?.trades) return;
    state.snapshotMeta = f;
    for (const t of f.trades) addTrade(t, false);
    if (state.source !== 'live') { state.source = 'snapshot'; refreshSourceLabel(); }
    migrateCopies();
  } catch { /* mid-deploy; next tick retries */ }
}

async function loadPositions() {
  try {
    const p = await snapshotJSON('data/whale_positions.json');
    if (!p) return;
    state.positions = state.liveRefresh ? state.liveRefresh.positionSnapshot(p)
      : { open: p.open || [], recently_closed: p.recently_closed || [] };
    state.posMeta = p;
    if (state.view === 'positions') renderPositions();
    migrateCopies();
    checkCopies();
  } catch { /* mid-deploy; next tick retries */ }
}

/* ───────────────────────── my copies (localStorage) ─────────────────── */

function loadCopies() {
  try {
    const saved = JSON.parse(lsGet(COPIES_KEY, '[]'));
    state.copies = Array.isArray(saved) ? saved.filter((c) => c && typeof c.key === 'string'
      && typeof c.wallet === 'string' && Number.isFinite(c.entryPrice)
      && c.entryPrice > 0 && c.entryPrice < 1 && Number.isFinite(c.stake) && c.stake > 0)
      .map((c) => ({ ...c, shares: c.stake / c.entryPrice, live: null, checkFailed: false })) : [];
  }
  catch { state.copies = []; }
}
function saveCopies() {
  lsSet(COPIES_KEY, JSON.stringify(state.copies));
  updateMineBadge();
}

function addCopy({ wallet, name, verdict, title, slug, outcome, price, stake, condition }) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1
      || !Number.isFinite(stake) || stake <= 0) return false;
  const key = posKey(wallet, slug, title, outcome, condition);
  if (state.copies.some((c) => c.key === key)) return false;   // already tracking
  state.copies.push({
    key, wallet: (wallet || '').toLowerCase(), name, verdict,
    title, slug, outcome, condition: condition || '',
    entryPrice: price, stake,
    shares: price > 0 ? stake / price : 0,
    addedAt: Math.floor(Date.now() / 1000),
    live: null,          // filled in by pollAllCopies() -- see below
  });
  saveCopies();
  pollAllCopies();
  return true;
}

function removeCopy(key) {
  state.copies = state.copies.filter((c) => c.key !== key);
  saveCopies();
  renderMine();
}

// A copy saved before `condition` was tracked (or made while the source data
// briefly lacked it) is permanently stuck on the old capped-board matching --
// pollAllCopies() below skips anything without a condition, by design. That
// reproduces the exact "goes blank" bug the live poll exists to fix, just for
// copies that predate it. Rather than only telling the owner to delete and
// re-copy it, try to recover the condition_id from whatever's currently
// loaded (same wallet + market + outcome) and backfill it in place.
function migrateCopies() {
  let changed = false;
  for (const c of state.copies) {
    if (c.condition) continue;
    // A title (or two empty slugs) cannot establish market identity. Only
    // recover a legacy key from a nonempty slug with one unique condition.
    const matches = (x) => x.wallet === c.wallet && x.condition && c.slug
      && x.slug === c.slug && (x.outcome || '') === (c.outcome || '');
    const hits = [...state.trades, ...state.positions.open,
      ...state.positions.recently_closed].filter(matches);
    const hit = hits[0];
    if (hit && new Set(hits.map((x) => x.condition)).size === 1) {
      c.condition = hit.condition;
      c.key = posKey(c.wallet, c.slug, c.title, c.outcome, c.condition);
      changed = true;
    }
  }
  if (changed) { saveCopies(); pollAllCopies(); }
}

/* ──────────────── THE BLANK-OUT FIX: poll each copy LIVE ────────────────
 *
 * Root cause of copies "going blank": whale_positions.json caps every whale
 * at 12 open / 8 closed positions server-side (see positions.py), sorted by
 * position VALUE descending. A busy whale routinely has hundreds of open
 * positions -- confirmed live, has_more stayed true past position #1 sorted
 * by value. So a copy of a whale's SMALLER or NEWER bet falls outside that
 * top-12 slice on the next 15-30 minute rebuild and silently disappears from
 * what the site can see, even though the whale still holds it.
 *
 * The fix: for tracked copies specifically -- a small, known set -- query
 * Polymarket's OWN position endpoint directly from THIS browser for exactly
 * that wallet + that market. CORS is open (verified: access-control-allow-
 * origin: *), no server cap applies because we ask for one specific position,
 * not "give me your top N". This bypasses the committed-JSON staleness
 * for tracked copies, but REST itself is still cached for up to five minutes.
 */
const POLY_DATA = 'https://data-api.polymarket.com/v2';
// Every 5 s, not every second: each check is 1-2 relay requests per copy, and at
// 1 s one open tab with one copy spent ~7,000 of the relay's free 100,000 daily
// requests an hour -- the quota ran out and the whole page went dark (2026-09-24).
const COPY_POLL_MS = 5000;
let copiesPolling = false;
let copiesRetryAt = 0;

async function positionRows(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const direct = new URL(url);
    const relay = relayUrl();
    const target = new URL(relay ? `${relay}/api/data${direct.pathname}${direct.search}` : direct.href);
    target.searchParams.set('_',String(Date.now()));
    const response = await fetch(target.href, { signal: controller.signal, cache:'no-store' });
    if (!response.ok) throw new Error(`Positions HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error('Invalid positions response');
    return body.data;
  } finally { clearTimeout(timer); }
}

async function liveCopyLookup(wallet, condition, outcome) {
  // Omitting status defaults to OPEN only server-side (verified) -- a closed
  // position returns an empty array, indistinguishable from "never existed".
  // So: ask OPEN first; only if that is empty do we ask CLOSED, which is the
  // one call that actually tells us "yes, they exited, here is when".
  //
  // MUST filter by outcome, not just "did the condition return any row at
  // all". A binary market has two outcome tokens (Yes/No) under one
  // condition_id, and a wallet can hold one OPEN while the other is CLOSED --
  // caught live in testing: a wallet had realized +$6,467 exiting "Yes" while
  // still holding an unrelated open "No" position on the same market. An
  // unfiltered check would have reported the Yes copy as "still in", which is
  // worse than the original blank-out bug -- confidently wrong instead of
  // honestly unknown.
  const base = `${POLY_DATA}/positions?${new URLSearchParams({ user: wallet, condition })}`;
  try {
    const open = await positionRows(`${base}&status=OPEN`);
    const openMatch = open.filter((r) => (r.outcome || '') === (outcome || ''));
    if (openMatch.length) return { state: 'in', rows: openMatch, checkedAt: Date.now() };

    const closed = await positionRows(`${base}&status=CLOSED`);
    const closedMatch = closed.filter((r) => (r.outcome || '') === (outcome || ''));
    closedMatch.sort((a, b) => Number(b.last_event_at || 0) - Number(a.last_event_at || 0));
    if (closedMatch.length) return { state: 'exited', rows: closedMatch, checkedAt: Date.now() };

    return { state: 'unknown', rows: [], checkedAt: Date.now() };
  } catch {
    return null;   // network hiccup -- keep whatever we had, don't flip to unknown
  }
}

async function pollAllCopies() {
  if (copiesPolling || Date.now() < copiesRetryAt) return;
  copiesPolling = true;
  try {
    const targets = state.copies.filter((c) => c.condition);
    // Limit concurrent requests and prevent overlapping timer batches.
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (targets.length) {
        const c = targets.shift();
        const result = await liveCopyLookup(c.wallet, c.condition, c.outcome);
        c.checkFailed = !result;
        if (result) c.live = result;
      }
    }));
    copiesRetryAt = state.copies.some(c => c.checkFailed) ? Date.now()+10_000 : 0;
    checkCopies();
  } finally { copiesPolling = false; }
}

/** Match one copy against what we know. Live poll result wins when we have
 * one (exact, un-capped); the committed board is the fallback for copies
 * saved before `condition` was tracked, or while the first poll is in flight. */
function copyStatus(c) {
  if (c.checkFailed) return { state: 'stale', checkedAt: c.live?.checkedAt };
  if (c.live) {
    if (Date.now() - c.live.checkedAt > POSITION_MAX_AGE_MS) {
      return { state: 'stale', checkedAt: c.live.checkedAt };
    }
    const row = c.live.rows.find((r) => (r.outcome || '') === (c.outcome || '')) || c.live.rows[0];
    if (c.live.state === 'in') {
      return { state: 'in', price: row?.current_price, whalePos: row, checkedAt: c.live.checkedAt };
    }
    if (c.live.state === 'exited') {
      if (!(Number(row?.last_event_at) >= c.addedAt)) return { state: 'unknown', checkedAt: c.live.checkedAt };
      return {
        state: 'exited', exitedAt: row?.last_event_at, whalePos: row,
        checkedAt: c.live.checkedAt,
      };
    }
    // live poll ran and found nothing in open OR closed -- genuinely unknown,
    // not a stale-cap artifact, so trust it over the committed fallback below.
    return { state: 'unknown', checkedAt: c.live.checkedAt };
  }

  if (!c.condition) return { state: 'unknown' };
  const snapshotAt = Number(state.posMeta?.generated_at || 0) * 1000;
  const openHit = state.positions.open.find((p) => posKey(p.wallet, p.slug, p.title, p.outcome, p.condition) === c.key);
  const closedHit = state.positions.recently_closed.find(
    (p) => posKey(p.wallet, p.slug, p.title, p.outcome, p.condition) === c.key);
  const observedAt = openHit?._receivedAt || closedHit?._receivedAt || snapshotAt;
  if (!observedAt || Date.now() - observedAt > POSITION_MAX_AGE_MS) return { state: 'stale' };
  if (openHit) return { state: 'in', price: openHit.current_price, whalePos: openHit };
  if (closedHit && Number(closedHit.last_event_at) >= c.addedAt) return { state: 'exited', exitedAt: closedHit.last_event_at, whalePos: closedHit };
  return { state: 'unknown' };
}

function checkCopies() {
  let alerts = 0;
  for (const c of state.copies) {
    const st = copyStatus(c);
    if (st.state === 'exited') {
      alerts += 1;
      if ($('#mine-notify')?.checked && !state.notified.has(c.key)
          && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        state.notified.add(c.key);
        // Actionable, not just a fact: what you put in, at what price, and
        // where to go decide -- rather than guess a live P&L number here that
        // could already be stale by the time the notification is read.
        new Notification(`${displayName(c.name, c.wallet)} just exited`, {
          body: `${c.title || ''}${c.outcome ? ` (${c.outcome})` : ''} — they got out `
            + `${ago(st.exitedAt)} ago. You put in ${money(c.stake)} at `
            + `${((c.entryPrice || 0) * 100).toFixed(0)}¢ and are still in. Open My Copies `
            + 'to see your current price and decide whether to follow them out.',
          tag: c.key,
        });
      }
    }
  }
  updateMineBadge(alerts);
  if (state.view === 'mine') renderMine();
  return alerts;
}

function updateMineBadge(alerts) {
  const b = $('#mine-badge');
  if (!b) return;
  const n = alerts ?? state.copies.filter((c) => copyStatus(c).state === 'exited').length;
  b.hidden = !n;
  b.textContent = String(n);
}

function copyButton(data) {
  const already = state.copies.some(
    (c) => c.key === posKey(data.wallet, data.slug, data.title, data.outcome, data.condition));
  const btn = el('button', `btn copybtn ${already ? 'tracking' : ''}`,
    already ? '✓ Tracking' : '⚡ Copy this');
  if (already) btn.disabled = true;
  btn.addEventListener('click', () => {
    if (addCopy(data)) {
      btn.textContent = '✓ Tracking';
      btn.className = 'btn copybtn tracking';
      btn.disabled = true;
    }
  });
  return btn;
}

/* ──────────────────────────── live buys ─────────────────────────────── */

// A bet stays visible for TRADE_VISIBLE_S after it happened, then drops off
// on its own rather than being pushed off by whatever arrived after it.
// Originally 5 minutes; tightened to 2 once Min bet defaulted to $0 -- at
// that volume a 5-minute-old row reads as stale next to what's arriving every
// few seconds now. MAX_ROWS is kept only as a safety valve against a genuine
// flood, not the normal way rows leave.
const TRADE_VISIBLE_S = 2 * 60;

function visibleTrades() {
  const min = Number($('#t-min').value) || 0;
  const cutoff = Date.now() / 1000 - TRADE_VISIBLE_S;
  return state.trades
    .filter((t) => {
      if (state.watchOnly && !isWatched(t.wallet)) return false;
      if (t.ts < cutoff) return false;
      if (t.usd < min) return false;
      if (state.tradeCategory && t.category !== state.tradeCategory) return false;
      if (state.who === 'best') return t.verdict === 'CANDIDATE' || t.verdict === 'WATCH';
      if (state.who === 'all') return !!t.verdict;
      return !isChurn(t);
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ROWS);
}

// The tape used to be thrown away and rebuilt every second. On a busy tape the
// top row changed within 1.5s in testing, so a click aimed at "Copy this"
// could land on a different bet than the one read -- and a mouse-down on a
// button removed before mouse-up was simply lost. Rows are now kept per trade
// and updated in place. New bets are HELD while the pointer is on the list,
// just after a touch, while scrolled down into it, or while paused; they wait
// in a floating banner that takes no layout space, so nothing moves under you.
const tradeKey = (t) => `${t.tx}|${t.wallet}|${t.ts}|${t.usd}`;
const TAPE_TOUCH_HOLD_MS = 5000;

function tapeHeld() {
  if (state.paused || state.tapeHover || Date.now() < state.tapeTouchUntil) return true;
  const f = document.activeElement;
  if (f?.closest?.('#tape') && f.matches?.(':focus-visible')) return true;
  const list = $('#tape');
  return !!list && list.getBoundingClientRect().top < -40;
}

function showTapeHold(pending) {
  const box = $('#tape-hold');
  if (!box) return;
  box.hidden = !pending;
  if (!pending) return;
  const s = pending === 1 ? '' : 's';
  $('#tape-hold-text').textContent = state.paused
    ? `Paused · ${pending} new bet${s} waiting`
    : `${pending} new bet${s} held so the list doesn't move under you`;
  $('#tape-hold-show').textContent = state.paused ? 'Resume' : 'Show them';
}

function buildTradeRow(t, stake) {
  const combo = isCombo(t);
  const fresh = t.live && (Date.now() / 1000 - t.ts) < 90;
  const li = el('li', `row${fresh ? ' fresh' : ''}`);
  li._t = t;

  const who = el('div', 'who');
  const nm = el('span', 'nm', displayName(t.name, t.wallet));
  const card = state.byWallet.get(t.wallet);
  if (card) nm.addEventListener('click', () => openDrawer(card));
  who.appendChild(nm);
  if (t.verdict) who.appendChild(verdictPill(t.verdict));
  if (combo) who.appendChild(el('span', 'tag', 'PARLAY'));
  li._who = who;
  li._stack = null;
  li.appendChild(who);

  const right = el('div');
  right.appendChild(el('div', 'headline-num', money(t.usd)));
  li._ago = right.appendChild(el('div', 'headline-sub', `${ago(t.ts)} ago`));
  li.appendChild(right);

  // plain sentence rather than a row of symbols
  const says = el('div', 'says');
  const sideSpan = el('span', `side ${t.side}`, t.side === 'BUY' ? 'BOUGHT' : 'SOLD');
  says.appendChild(sideSpan);
  says.appendChild(document.createTextNode(combo
    ? ' a multi-market parlay'
    : ` "${t.outcome || '?'}" at ${(t.price * 100).toFixed(0)}¢`));
  li.appendChild(says);

  const mk = el('div', 'mkt');
  mk.appendChild(marketLink(t.title, t.slug));
  if (t.end_date) mk.appendChild(el('span', 'tag plain', closesIn(t.end_date)));
  mk.appendChild(copyMarketBtn(t.title));
  li.appendChild(mk);

  if (combo) {
    li.appendChild(el('div', 'mirror',
      'A parlay bundles several markets into one bet — a single copy trade cannot reproduce it.'));
  } else if (t.price > 0 && t.price < 1) {
    const shares = stake / t.price;
    const mirror = el('div', 'mirror');
    mirror.innerHTML = `To copy at $${stake} you'd buy <b>${shares.toFixed(shares < 10 ? 1 : 0)} shares</b> `
      + `— that's their price. Arriving later you'll likely pay more.`;
    li.appendChild(mirror);

    const data = {
      wallet: t.wallet, name: t.name, verdict: t.verdict,
      title: t.title, slug: t.slug, outcome: t.outcome,
      price: t.price, stake, condition: t.condition,
    };
    const actions = el('div', 'actions');
    li._copy = actions.appendChild(copyButton(data));
    li._copyKey = posKey(data.wallet, data.slug, data.title, data.outcome, data.condition);
    li.appendChild(actions);
  }
  updateTradeRow(li, { layout: true });
  return li;
}

// `layout:false` while held: only text that can't change a row's height, so a
// badge wrapping onto a new line can't shove the rows under the pointer.
function updateTradeRow(li, { layout }) {
  const t = li._t;
  li._ago.textContent = `${ago(t.ts)} ago`;
  if (!layout) return;
  const a = marketActivity(t.wallet, t.condition);
  const label = a ? (a.mixed ? '⇄ both sides of this market' : `🔁 ${a.count}× this market`) : '';
  if (label !== (li._stack?.textContent || '')) {
    li._stack?.remove();
    li._stack = label ? li._who.appendChild(el('span', 'tag stack', label)) : null;
  }
  if (li._copy && !li._copy.disabled && state.copies.some((c) => c.key === li._copyKey)) {
    li._copy.textContent = '✓ Tracking';
    li._copy.className = 'btn copybtn tracking';
    li._copy.disabled = true;
  }
}

function renderTrades({ force = false } = {}) {
  const list = $('#tape');
  const empty = $('#tape-empty');
  const stake = Number($('#t-stake').value) || 25;
  if (state.tapeReset || stake !== state.tapeStake) {
    state.tapeNodes.clear();
    list.textContent = '';
    state.tapeReset = false;
    state.tapeStake = stake;
  }
  const rows = visibleTrades();
  const held = !force && !state.tapeForce && tapeHeld();
  state.tapeForce = false;

  if (held) {
    for (const li of state.tapeNodes.values()) updateTradeRow(li, { layout: false });
    showTapeHold(rows.filter((t) => !state.tapeNodes.has(tradeKey(t))).length);
    return;
  }
  showTapeHold(0);

  if (!rows.length) {
    state.tapeNodes.clear();
    list.textContent = '';
    empty.hidden = false;
    // Three genuinely different reasons for an empty tape, misdiagnosed as
    // one before -- "lower your min bet" was shown even with min bet already
    // at $0, whenever the real cause was the 2-minute window (nothing THAT
    // recent yet, not nothing big enough).
    if (state.watchOnly && !state.watchlist.size) {
      empty.textContent = 'Your watchlist is empty. Follow a whale or turn off “Only whales I follow”.';
    } else if (state.source !== 'live') {
      empty.textContent = 'Live trades are disconnected. Saved trades may be outside the two-minute window. Open data source to check the connection.';
    } else if (!state.trades.length) {
      empty.textContent = state.source === 'live' ? 'Connected. Waiting for bets…' : 'Loading…';
    } else {
      const cutoff = Date.now() / 1000 - TRADE_VISIBLE_S;
      const recent = state.trades.filter((t) => t.ts >= cutoff).length;
      empty.textContent = recent
        ? `${recent} bet${recent === 1 ? '' : 's'} in the last ${TRADE_VISIBLE_S / 60} min, `
          + 'but none match min bet / topic / who right now. Loosen a filter to see them.'
        : `Nothing in the last ${TRADE_VISIBLE_S / 60} minutes yet — this tape clears fast. `
          + 'A new bet will show up here the moment one comes in.';
    }
    return;
  }
  empty.hidden = true;

  const want = new Set(rows.map(tradeKey));
  for (const [k, li] of state.tapeNodes) {
    if (!want.has(k)) { li.remove(); state.tapeNodes.delete(k); }
  }
  let prev = null;
  for (const t of rows) {
    const k = tradeKey(t);
    let li = state.tapeNodes.get(k);
    if (li) updateTradeRow(li, { layout: true });
    else { li = buildTradeRow(t, stake); state.tapeNodes.set(k, li); }
    const at = prev ? prev.nextSibling : list.firstChild;
    if (at !== li) list.insertBefore(li, at);
    prev = li;
  }
}

/* ────────────────────────── what they hold ──────────────────────────── */

// A "just got out" this recent gets the same loud alert treatment as a My
// Copies exit -- requested explicitly: any followed whale's exit should be
// something you're ALERTED to, not just a quiet pill you'd only notice by
// scrolling past it.
const FRESH_EXIT_S = 10 * 60;

function renderPositions() {
  const open = state.positions.open.filter(p => !state.watchOnly || isWatched(p.wallet));
  const recently_closed = state.positions.recently_closed.filter(p => !state.watchOnly || isWatched(p.wallet));
  const showOpen = state.posFilter !== 'closed';
  const showClosed = state.posFilter !== 'open';
  let rows = [
    ...(showOpen ? open.map((p) => ({ ...p, _open: true })) : []),
    ...(showClosed ? recently_closed.map((p) => ({ ...p, _open: false })) : []),
  ];
  if (state.posCategory) rows = rows.filter((p) => p.category === state.posCategory);
  if (state.holdingWallet) rows = rows.filter(p => p.wallet === state.holdingWallet);
  // TRUE chronological order across open+closed. Each half arrives from the
  // server already sorted by last_event_at, but concatenating them means
  // "Everything" showed every open position before any exit regardless of
  // which was more recent -- a fresh exit could sit buried behind hundreds
  // of unrelated open positions. last_event_at is populated on both.
  rows.sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0));

  const list = $('#positions');
  const empty = $('#positions-empty');
  list.textContent = '';
  renderPositionStats();

  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.posMeta ? 'Nothing here for this filter.' : 'Loading…';
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const p of rows.slice(0, 250)) {
    const justExited = !p._open && p.last_event_at
      && (Date.now() / 1000 - p.last_event_at) < FRESH_EXIT_S;
    const li = el('li', `row${justExited ? ' alert' : ''}`);

    if (justExited) {
      li.appendChild(el('div', 'alert-banner',
        `⚠ ${displayName(p.name, p.wallet)} just got out — ${ago(p.last_event_at)} ago.`));
    }

    const who = el('div', 'who');
    const nm = el('span', 'nm', displayName(p.name, p.wallet));
    const card = state.byWallet.get((p.wallet || '').toLowerCase());
    if (card) nm.addEventListener('click', () => openDrawer(card));
    who.appendChild(nm);
    if (p.verdict) who.appendChild(verdictPill(p.verdict));
    who.appendChild(el('span', `pstatus ${p._open ? 'open' : 'exited'}`,
      p._open ? 'STILL HOLDING' : 'GOT OUT'));
    li.appendChild(who);

    const received = p._receivedAt ? p._receivedAt / 1000 : state.posMeta?.generated_at;
    const ageLabel = el('div', 'why');
    ageLabel.dataset.received = received || 0;
    ageLabel.dataset.source = p._receivedAt ? 'API received' : 'Saved snapshot';
    ageLabel.dataset.coverage = state.liveRefresh?.walletChecks[p.wallet]?.truncated ? ' · capped API sample' : '';
    ageLabel.textContent = `${ageLabel.dataset.source} ${received ? ago(received)+' ago' : 'age unknown'}${ageLabel.dataset.coverage}`;
    li.appendChild(ageLabel);

    const pnl = p._open ? p.unrealized_pnl : p.realized_pnl;
    const right = el('div');
    right.appendChild(el('div', `headline-num ${sign(pnl)}`, money(pnl)));
    right.appendChild(el('div', 'headline-sub',
      p._open ? 'on paper' : `banked ${ago(p.last_event_at)} ago`));
    li.appendChild(right);

    const says = el('div', 'says');
    says.innerHTML = p.outcome
      ? `Backing <b>${escapeHTML(p.outcome)}</b> — bought in at <b>${((p.avg_price || 0) * 100).toFixed(0)}¢</b>`
        + (p._open && p.current_price
          ? `, now <b>${(p.current_price * 100).toFixed(0)}¢</b>` : '')
      : 'Multi-market position';
    li.appendChild(says);

    const mk = el('div', 'mkt');
    mk.appendChild(marketLink(p.title, p.slug));
    mk.appendChild(copyMarketBtn(p.title));
    li.appendChild(mk);

    if (p.likely_hedge_residue) {
      li.appendChild(el('div', 'why',
        'Bought at exactly 50¢ on a linked multi-outcome market — this is usually left over '
        + 'from a hedge conversion, not a price they actively chose.'));
    }

    if (p._open && p.outcome) {
      const actions = el('div', 'actions');
      actions.appendChild(copyButton({
        wallet: p.wallet, name: p.name, verdict: p.verdict,
        title: p.title, slug: p.slug, outcome: p.outcome,
        price: p.current_price || p.avg_price,
        stake: Number($('#t-stake')?.value) || 25, condition: p.condition,
      }));
      li.appendChild(actions);
    }

    frag.appendChild(li);
  }
  list.appendChild(frag);
}

function renderPositionStats() {
  const box = $('#p-stats');
  box.textContent = '';
  const add = (k, v) => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', 'v', v));
    box.appendChild(d);
  };
  const inScope = p => (!state.holdingWallet || p.wallet === state.holdingWallet)
    && (!state.watchOnly || isWatched(p.wallet)) && (!state.posCategory || p.category === state.posCategory);
  add('Still holding', String(state.positions.open.filter(inScope).length));
  add('Got out (7 days)', String(state.positions.recently_closed.filter(inScope).length));
  if (state.posMeta?.generated_at) add('Saved fallback', `${ago(state.posMeta.generated_at)} ago`);
  state.liveRefresh?.paintStatus();
  document.querySelectorAll('[data-received]').forEach(n => {
    const at = Number(n.dataset.received);
    n.textContent = `${n.dataset.source} ${at ? ago(at)+' ago' : 'age unknown'}${n.dataset.coverage}`;
  });
}

/* ─────────────────────────── closing soon (markets) ──────────────────── *
 * Market-centric rather than whale-centric: what can be traded right now,
 * grouped by how soon it closes. Requested as the priority feature -- "few
 * hours to day-end" is the stated primary trading window -- so it defaults to
 * that bucket, not the widest one. */

const BUCKET_LABEL = { hours: 'Next few hours', today: 'By end of today',
  weekend: 'By end of the weekend', month: 'By end of the month', year: 'By end of the year' };

async function loadMarketsSoon() {
  try {
    const m = await snapshotJSON('data/markets_soon.json');
    if (!m?.buckets) return;
    state.marketsSoon = state.liveRefresh ? state.liveRefresh.marketSnapshot(m) : m;
    if (state.view === 'soon') renderMarketsSoon();
  } catch { /* mid-deploy; next tick retries */ }
}

// countdown string from an ISO end_date to now
function closesIn(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'closing now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `closes in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `closes in ${hrs}h ${mins % 60}m`;
  return `closes in ${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// Cross-reference: which screened, followed whales (CANDIDATE/WATCH -- the
// same "Followed whales" default as the Live buys tab) have a fill on THIS
// exact market. Deliberately not limited to a tight recent window the way the
// live tape is -- whale fills are sparse per single market, so a hard cutoff
// would show "nothing" almost always. Recency is surfaced via the timestamp
// on each row instead of hidden behind a cutoff.
function whaleBetsOn(condition) {
  if (!condition) return [];
  return state.trades
    .filter((t) => (!state.watchOnly || isWatched(t.wallet)) && t.condition === condition
      && (t.verdict === 'CANDIDATE' || t.verdict === 'WATCH'))
    .sort((a, b) => b.ts - a.ts);
}

function renderMarketsSoon() {
  const list = $('#soon-list');
  const empty = $('#soon-empty');
  if (!list) return;
  const data = state.marketsSoon;
  if (!data) { empty.hidden = false; empty.textContent = 'Loading…'; list.textContent = ''; return; }

  const rows = (data.buckets[state.marketsBucket] || []).filter(m => Date.parse(m.end_date) > Date.now());
  const statBox = $('#soon-stats');
  if (statBox) {
    statBox.textContent = '';
    const add = (k, v) => {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v', v));
      statBox.appendChild(d);
    };
    add('Open markets', String(rows.length));
    add('Window ends', closesIn(data.bucket_ends?.[state.marketsBucket]));
    const liveAt = state.liveRefresh?.marketChecks[state.marketsBucket]?.at;
    if (liveAt) add('API received', `${ago(liveAt / 1000)} ago`);
    else if (data.generated_at) add('Saved fallback', `${ago(data.generated_at)} ago`);
    state.liveRefresh?.paintStatus();
  }

  list.textContent = '';
  if (!rows.length) {
    empty.hidden = false;
    const receivedAt = state.liveRefresh?.marketChecks[state.marketsBucket]?.at || 0;
    empty.textContent = receivedAt && Date.now() - receivedAt < 15_000
      ? 'No matching markets returned by the latest API check (up to 40 sampled).'
      : 'Current markets are unavailable. The saved sample has no unexpired markets; this does not mean no markets are open. Live connection required.';
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const m of rows) {
    const li = el('li', 'row');

    const who = el('div', 'who');
    who.appendChild(marketLink(m.title, m.slug));
    if (m.neg_risk) who.appendChild(el('span', 'tag plain', 'multi-outcome'));
    who.appendChild(copyMarketBtn(m.title));
    li.appendChild(who);

    const right = el('div');
    right.appendChild(el('div', 'headline-num', money(m.volume)));
    right.appendChild(el('div', 'headline-sub', 'total volume'));
    li.appendChild(right);

    const says = el('div', 'says');
    if (m.outcomes?.length === 2 && m.prices?.length === 2) {
      says.innerHTML = `<b>${escapeHTML(m.outcomes[0])}</b> ${(m.prices[0] * 100).toFixed(0)}¢ · `
        + `<b>${escapeHTML(m.outcomes[1])}</b> ${(m.prices[1] * 100).toFixed(0)}¢`;
    } else {
      says.textContent = `${m.outcomes?.length || '?'} outcomes`;
    }
    li.appendChild(says);

    const mk = el('div', 'mkt');
    mk.textContent = `${closesIn(m.end_date)} · liquidity ${money(m.liquidity)}`;
    li.appendChild(mk);

    // the actual question this tab exists to answer: is a whale already on
    // this closing-soon market, and if so, which side
    const bets = whaleBetsOn(m.condition);
    if (bets.length) {
      const wb = el('div', 'whalebets');
      wb.appendChild(el('div', 'wblabel',
        `🐳 ${bets.length} followed whale${bets.length === 1 ? '' : 's'} betting here`));
      for (const t of bets.slice(0, 4)) {
        const row = el('div', 'wbrow');
        row.appendChild(el('b', 'wbname', displayName(t.name, t.wallet)));
        row.appendChild(document.createTextNode(` ${t.side === 'BUY' ? 'bought' : 'sold'} `));
        row.appendChild(el('b', null, t.outcome || '?'));
        row.appendChild(document.createTextNode(
          ` at ${(t.price * 100).toFixed(0)}¢ (${money(t.usd)}) · ${ago(t.ts)} ago`));
        wb.appendChild(row);
      }
      if (bets.length > 4) wb.appendChild(el('div', 'wbrow mut', `+${bets.length - 4} more`));

      const top = bets[0];
      if (top.price > 0 && top.price < 1) {
        wb.appendChild(copyButton({
          wallet: top.wallet, name: top.name, verdict: top.verdict,
          title: top.title, slug: top.slug, outcome: top.outcome,
          price: top.price, stake: Number($('#t-stake')?.value) || 25,
          condition: top.condition,
        }));
      }
      li.appendChild(wb);
    } else {
      li.appendChild(el('div', 'wbempty', 'No followed whale has bet on this one recently.'));
    }

    frag.appendChild(li);
  }
  list.appendChild(frag);
}

/* ───────────────────────────── crypto flows ──────────────────────────── *
 * A DIFFERENT kind of whale entirely -- large USDT/USDC transfers on
 * Ethereum, from public on-chain data (Blockscout), not Polymarket. Binance
 * was ruled out (its public API is fully anonymous -- no trader identity at
 * any price) and Whale Alert was ruled out (no free API tier, and even paid
 * it only attributes to entities, not individual traders). This is the one
 * free, public, wallet-level source left -- but it is a fund movement, not a
 * trade, so there is deliberately no "copy this" anywhere in this section. */

async function loadCryptoFlows() {
  try {
    const f = await snapshotJSON('data/crypto_flows.json');
    if (!f?.flows) return;
    state.cryptoFlows = f;
    if (state.view === 'flows') renderCryptoFlows();
  } catch { /* mid-deploy, or the sweep failed this cycle -- next tick retries */ }
}

function renderCryptoFlows() {
  const list = $('#flows-list');
  const empty = $('#flows-empty');
  if (!list) return;
  const data = state.cryptoFlows;
  if (!data) { empty.hidden = false; empty.textContent = 'Loading…'; list.textContent = ''; return; }

  const statBox = $('#flows-stats');
  if (statBox) {
    statBox.textContent = '';
    const add = (k, v) => {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v', v));
      statBox.appendChild(d);
    };
    add('Transfers shown', String(data.flows.length));
    add('Minimum size', money(data.min_usd));
    if (data.generated_at) add('Updated', `${ago(data.generated_at)} ago`);
  }

  list.textContent = '';
  if (!data.flows.length) {
    empty.hidden = false;
    empty.textContent = `Nothing at or above ${money(data.min_usd)} in the last check — `
      + 'a quieter moment, not a broken feed.';
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const f of data.flows) {
    const li = el('li', 'row');

    const who = el('div', 'who');
    who.appendChild(el('span', 'nm', f.symbol));
    who.appendChild(el('span', 'tag plain', 'on-chain, not Polymarket'));
    li.appendChild(who);

    const right = el('div');
    right.appendChild(el('div', 'headline-num', money(f.usd)));
    right.appendChild(el('div', 'headline-sub', `${ago(f.ts)} ago`));
    li.appendChild(right);

    const says = el('div', 'says');
    says.appendChild(document.createTextNode('From '));
    says.appendChild(el('b', null, f.from_label || short(f.from)));
    says.appendChild(document.createTextNode(' to '));
    says.appendChild(el('b', null, f.to_label || short(f.to)));
    li.appendChild(says);

    const mk = el('div', 'mkt');
    const a = el('a', null, `${f.amount.toLocaleString()} ${f.symbol} on Etherscan`);
    if (f.tx) { a.href = `https://etherscan.io/tx/${f.tx}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    mk.appendChild(a);
    li.appendChild(mk);

    frag.appendChild(li);
  }
  list.appendChild(frag);
}

/* ───────────────────────────── my copies ────────────────────────────── */

function renderMine() {
  const list = $('#mine');
  const empty = $('#mine-empty');
  const alertBox = $('#mine-alerts');
  list.textContent = '';
  alertBox.textContent = '';

  const statBox = $('#mine-stats');
  statBox.textContent = '';
  const add = (k, v, cls) => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', `v ${cls || ''}`, v));
    statBox.appendChild(d);
  };

  if (!state.copies.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const rows = state.copies.map((c) => ({ c, st: copyStatus(c) }));
  const exited = rows.filter((r) => r.st.state === 'exited');
  const stillIn = rows.filter((r) => r.st.state === 'in');

  add('Copies tracked', String(state.copies.length));
  add('Whale still in', String(stillIn.length));
  add('Whale got out', String(exited.length), exited.length ? 'neg' : '');

  if (exited.length) {
    const banner = el('div', 'callout warn');
    banner.innerHTML = `<b>⚠ ${exited.length} whale${exited.length > 1 ? 's have' : ' has'} `
      + `exited a position you copied.</b> They're out and you may still be in. `
      + `This is a fact about what they did — not advice that you should follow.`;
    alertBox.appendChild(banner);
  }

  // exited first — that's the thing you need to see
  rows.sort((a, b) => {
    const rank = (s) => (s === 'exited' ? 0 : s === 'in' ? 1 : 2);
    return rank(a.st.state) - rank(b.st.state);
  });

  const frag = document.createDocumentFragment();
  for (const { c, st } of rows) {
    const li = el('li', `row${st.state === 'exited' ? ' alert' : ''}`);

    if (st.state === 'exited') {
      li.appendChild(el('div', 'alert-banner',
        `⚠ ${displayName(c.name, c.wallet)} GOT OUT ${ago(st.exitedAt)} ago — you may still be in.`));
    }

    const who = el('div', 'who');
    who.appendChild(el('span', 'nm', displayName(c.name, c.wallet)));
    if (c.verdict) who.appendChild(verdictPill(c.verdict));
    who.appendChild(el('span',
      `pstatus ${st.state === 'in' ? 'open' : 'exited'}`,
      st.state === 'in' ? 'THEY\'RE STILL IN' : st.state === 'exited' ? 'THEY\'RE OUT' : st.state === 'stale' ? 'DATA UNAVAILABLE / OLD' : 'CAN\'T SEE'));
    // Request age is not market-data age: REST can still be cached.
    if (st.checkedAt) {
      const liveTag = el('span', 'tag plain',
        `API checked ${Math.max(1, Math.round((Date.now() - st.checkedAt) / 1000))}s ago`);
      who.appendChild(liveTag);
    } else if (!c.condition) {
      who.appendChild(el('span', 'tag plain', 'older copy — market identity unconfirmed'));
    }
    li.appendChild(who);

    // your own P&L on the copy, if we can price it
    const nowPrice = st.price ?? null;
    const right = el('div');
    if (nowPrice != null && c.entryPrice > 0) {
      const myPnl = c.shares * (nowPrice - c.entryPrice);
      right.appendChild(el('div', `headline-num ${sign(myPnl)}`, money(myPnl)));
      right.appendChild(el('div', 'headline-sub', 'estimated P&L · before fees / slippage'));
    } else {
      right.appendChild(el('div', 'headline-num mut', money(c.stake)));
      right.appendChild(el('div', 'headline-sub', 'you staked'));
    }
    li.appendChild(right);

    const says = el('div', 'says');
    says.innerHTML = `You backed <b>${escapeHTML(c.outcome || '?')}</b> at `
      + `<b>${((c.entryPrice || 0) * 100).toFixed(0)}¢</b> with `
      + `<b>${money(c.stake)}</b> (${(c.shares || 0).toFixed(c.shares < 10 ? 1 : 0)} shares)`
      + (nowPrice != null ? ` · now <b>${(nowPrice * 100).toFixed(0)}¢</b>` : '');
    li.appendChild(says);

    const mk = el('div', 'mkt');
    mk.appendChild(marketLink(c.title, c.slug));
    li.appendChild(mk);

    if (st.state === 'stale') {
      li.appendChild(el('div', 'why', 'Position data is old or the latest request failed. Holdings and P&L cannot be confirmed. REST responses can also lag by up to five minutes.'));
    }
    if (st.state === 'unknown') {
      li.appendChild(el('div', 'why', st.checkedAt
        ? "The last cached API check did not confirm an open position or an exit after you saved this copy. "
          + 'This does not establish that the whale has exited.'
        : "Not yet in the whale's currently-tracked holdings or their last 7 days of exits. "
          + 'API checks target one second, slowing down after failures; upstream freshness is not guaranteed.'));
    }

    const actions = el('div', 'actions');
    const del = el('button', 'btn small', 'Remove');
    del.addEventListener('click', () => removeCopy(c.key));
    actions.appendChild(del);
    const card = state.byWallet.get(c.wallet);
    if (card) {
      const view = el('button', 'btn small', 'Their record');
      view.addEventListener('click', () => openDrawer(card));
      actions.appendChild(view);
    }
    li.appendChild(actions);

    frag.appendChild(li);
  }
  list.appendChild(frag);
}

/* ──────────────────────── who to follow (board) ─────────────────────── */

const ORDER = { CANDIDATE: 0, WATCH: 1, FRAGILE: 2, 'NOT COPYABLE': 3, INSUFFICIENT: 4 };
const isGood = (c) => c.position_pnl > 0 && (c.verdict === 'CANDIDATE' || c.verdict === 'WATCH');

function renderBoard() {
  const sortKey = $('#w-sort').value;
  let rows = state.whales.filter((c) => {
    if (state.watchOnly && !isWatched(c.wallet)) return false;
    if (state.verdict === 'good' && !isGood(c)) return false;
    if (state.verdict && state.verdict !== 'good' && c.verdict !== state.verdict) return false;
    if (state.category) {
      const cats = c.lb_categories || [];
      if (!cats.includes(state.category) && c.category !== state.category) return false;
    }
    return true;
  });

  const hint = $('#w-sort-hint');
  if (sortKey === 'lb_day_pnl' || sortKey === 'lb_week_pnl') {
    const have = rows.filter((c) => c[sortKey] != null).length;
    hint.hidden = false;
    hint.textContent = `${have} of these ${rows.length} appeared on Polymarket's `
      + `${sortKey === 'lb_day_pnl' ? 'daily' : 'weekly'} leaderboard — the rest sort to the `
      + `bottom. That figure is Polymarket's own, over a short window, so it's noisier than the `
      + `overall rating.`;
    rows.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  } else {
    hint.hidden = true;
    rows.sort((a, b) => {
      if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
      if (sortKey === 'screen') {
        const d = (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9);
        if (d) return d;
        return (b.net_dd ?? -Infinity) - (a.net_dd ?? -Infinity);
      }
      const av = a[sortKey], bv = b[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  }

  const list = $('#board');
  list.textContent = '';
  $('#board-empty').hidden = rows.length > 0;
  $('#board-empty').textContent = state.watchOnly && !state.watchlist.size
    ? 'Your watchlist is empty. Use “Show all screened whales” above to find whales to follow.'
    : 'Nothing matches these filters.';
  renderBoardStats(rows);

  const frag = document.createDocumentFragment();
  rows.slice(0, 200).forEach((c, i) => {
    const li = el('li', 'row');

    const who = el('div', 'who');
    who.appendChild(el('span', 'rank', String(i + 1)));
    const nm = el('span', 'nm', displayName(c.name, c.wallet));
    nm.addEventListener('click', () => openDrawer(c));
    who.appendChild(nm);
    who.appendChild(verdictPill(c.verdict));
    who.appendChild(watchButton(c));
    for (const topic of state.insights?.profiles?.[c.wallet]?.topics || []) {
      if (topic.specialist) who.appendChild(el('span', 'tag', `${CAT_LABEL[topic.category] || topic.category} specialist · sampled`));
    }
    const cat = catOf(c);
    if (cat && CAT_LABEL[cat]) who.appendChild(el('span', 'tag', CAT_LABEL[cat]));
    if (c.discovered) who.appendChild(el('span', 'tag plain', 'off-leaderboard'));
    li.appendChild(who);

    const showWindow = (sortKey === 'lb_day_pnl' || sortKey === 'lb_week_pnl')
      && c[sortKey] != null;
    const headline = showWindow ? c[sortKey] : c.position_pnl;
    const right = el('div');
    right.appendChild(el('div', `headline-num ${sign(headline)}`, money(headline)));
    right.appendChild(el('div', 'headline-sub',
      showWindow ? (sortKey === 'lb_day_pnl' ? 'made today' : 'made this week') : 'total profit'));
    li.appendChild(right);

    // plain-English facts instead of a jargon strip
    const facts = el('div', 'facts');
    const f = (k, v, cls) => {
      const d = el('div', 'f');
      d.appendChild(el('div', 'fk', k));
      d.appendChild(el('div', `fv ${cls || ''}`, v));
      facts.appendChild(d);
    };
    f('Worst daily-sampled drop', money(c.max_dd_usd), 'neg');
    f('Profit / historical drop', c.net_dd == null ? '—' : `$${c.net_dd.toFixed(1)}`);
    f('Winning months', `${(c.pct_positive_months ?? 0).toFixed(0)}%`);
    f('Bets placed', (c.trade_count || 0).toLocaleString());
    if (c.lb_day_pnl != null && !showWindow) f('Today', money(c.lb_day_pnl), sign(c.lb_day_pnl));
    li.appendChild(facts);

    if (c.flags?.length) {
      li.appendChild(el('div', 'why', c.flags[0]
        + (c.flags.length > 1 ? `  (+${c.flags.length - 1} more — tap the name)` : '')));
    }
    frag.appendChild(li);
  });
  list.appendChild(frag);
}

function renderBoardStats(rows) {
  const box = $('#w-stats');
  box.textContent = '';
  if (!state.whales.length) return;
  const v = {};
  for (const c of state.whales) v[c.verdict] = (v[c.verdict] || 0) + 1;
  const add = (k, val) => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', 'v', val));
    box.appendChild(d);
  };
  add('Worth following', String((v.CANDIDATE || 0) + (v.WATCH || 0)));
  add('Showing', String(rows.length));
  add('Checked in total', String(state.whales.length));
  if (state.meta?.generated_at) add('Scores calculated', `${ago(state.meta.generated_at)} ago`);

  const intro = $('#w-intro');
  if (intro) {
    intro.textContent = `Out of ${state.whales.length} traders checked, `
      + `${(v.CANDIDATE || 0) + (v.WATCH || 0)} are worth following and `
      + `${(v['NOT COPYABLE'] || 0)} were ruled out — mostly market makers whose prices you `
      + `can't get, or one lucky bet dressed up as a track record.`;
  }
}

/* ───────────────────────────── drawer ───────────────────────────────── */

function openDrawer(c) {
  const b = $('#drawer-body');
  b.textContent = '';
  b.appendChild(el('h2', 'dh', displayName(c.name, c.wallet)));
  b.appendChild(watchButton(c));
  b.appendChild(el('p', 'dsub', c.wallet));
  b.appendChild(verdictPill(c.verdict));
  const cat = catOf(c);
  if (cat && CAT_LABEL[cat]) {
    const t = el('span', 'tag', `mostly ${CAT_LABEL[cat]}`);
    t.style.marginLeft = '9px';
    b.appendChild(t);
  }

  const grid = el('div', 'grid');
  const cell = (k, v, cls) => {
    const d = el('div', 'cell');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', `val ${cls || ''}`, v));
    grid.appendChild(d);
  };
  cell('Total profit', money(c.position_pnl), sign(c.position_pnl));
  cell('Worst daily-sampled drop', money(c.max_dd_usd), 'neg');
  cell('Profit / historical drop', c.net_dd == null ? '—' : `$${c.net_dd.toFixed(2)}`);
  cell('Winning months', `${(c.pct_positive_months ?? 0).toFixed(0)}%`);
  cell('Bets placed', (c.trade_count || 0).toLocaleString());
  cell('Biggest single win', money(c.biggest_win));
  cell('% from one bet', pct(c.concentration));
  cell('Cash banked', money(c.realized_market_pnl), sign(c.realized_market_pnl));
  cell('Still on paper', money(c.unrealized_pnl), sign(c.unrealized_pnl));
  cell('Rebates / rewards', money(c.program_income), 'mut');
  cell('Total traded', money(c.volume_usdc));
  cell('Profit per $ traded', c.edge_per_dollar == null ? '—' : pct(c.edge_per_dollar, 2));
  cell('Fees paid', money(c.fees_paid), 'neg');
  if (c.lb_day_pnl != null) cell('Made today', money(c.lb_day_pnl), sign(c.lb_day_pnl));
  if (c.lb_week_pnl != null) cell('Made this week', money(c.lb_week_pnl), sign(c.lb_week_pnl));
  cell('Days of history', String(c.curve_days ?? '—'));
  cell('Days since a bet', c.days_idle == null ? '—' : String(c.days_idle));
  b.appendChild(grid);

  const mine = (arr) => arr.filter(
    (p) => (p.wallet || '').toLowerCase() === (c.wallet || '').toLowerCase());
  const openPos = mine(state.positions.open);
  const closedPos = mine(state.positions.recently_closed);
  if (openPos.length || closedPos.length) {
    b.appendChild(el('div', 'sec', 'Positions right now'));
    for (const p of openPos.slice(0, 6)) {
      const row = el('div');
      row.style.cssText = 'font-size:15px;color:var(--dim);margin-bottom:7px;line-height:1.5';
      row.innerHTML = `<span class="pstatus open">HOLDING</span> ${escapeHTML(p.title || '')} — `
        + `in at ${((p.avg_price || 0) * 100).toFixed(0)}¢, ${money(p.unrealized_pnl)} on paper`;
      b.appendChild(row);
    }
    for (const p of closedPos.slice(0, 6)) {
      const row = el('div');
      row.style.cssText = 'font-size:15px;color:var(--dim);margin-bottom:7px;line-height:1.5';
      row.innerHTML = `<span class="pstatus exited">GOT OUT</span> ${escapeHTML(p.title || '')} — `
        + `banked ${money(p.realized_pnl)}, ${ago(p.last_event_at)} ago`;
      b.appendChild(row);
    }
  }

  const theirTrades = state.trades.filter(
    (t) => (t.wallet || '').toLowerCase() === (c.wallet || '').toLowerCase());
  if (theirTrades.length >= 3) {
    const counts = {};
    for (const t of theirTrades) counts[t.category || 'other'] = (counts[t.category || 'other'] || 0) + 1;
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    b.appendChild(el('div', 'sec', 'What they actually trade'));
    const catRow = el('div', 'facts');
    for (const [cat, n] of ranked.slice(0, 6)) {
      const f = el('div', 'f');
      f.appendChild(el('div', 'fv', String(n)));
      f.appendChild(el('div', 'fk', CAT_LABEL[cat] || 'Other'));
      catRow.appendChild(f);
    }
    b.appendChild(catRow);
  }

  if (c.flags?.length) {
    b.appendChild(el('div', 'sec', 'Why it scored this way'));
    const ul = el('ul', 'flags');
    c.flags.forEach((f) => ul.appendChild(el('li', null, f)));
    b.appendChild(ul);
  }

  if (c.monthly?.length) {
    b.appendChild(el('div', 'sec', 'Month by month'));
    const max = Math.max(...c.monthly.map((m) => Math.abs(m.pnl)), 1);
    const bars = el('div', 'bars');
    c.monthly.forEach((m) => {
      const bar = el('div', `b ${m.pnl >= 0 ? 'up' : 'dn'}`);
      bar.style.height = `${Math.max(3, (Math.abs(m.pnl) / max) * 100)}%`;
      bar.title = `${m.month}: ${money(m.pnl)}`;
      bars.appendChild(bar);
    });
    b.appendChild(bars);
    const ax = el('div', 'axis');
    ax.appendChild(el('span', null, c.monthly[0].month));
    ax.appendChild(el('span', null, c.monthly[c.monthly.length - 1].month));
    b.appendChild(ax);
  }

  const link = el('a', null, 'Open their Polymarket profile ↗');
  link.href = `https://polymarket.com/profile/${c.wallet}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.style.cssText = 'display:inline-block;margin-top:26px';
  b.appendChild(link);

  $('#drawer').hidden = false;
}

/* ──────────────── method text, generated from the data ──────────────── */

function renderMethod() {
  const m = $('#method');
  if (!m || !state.whales.length) return;
  m.textContent = '';
  const rankable = state.whales.filter((c) => c.rankable);
  const richest = [...state.whales].sort((a, b) => b.position_pnl - a.position_pnl)[0];
  const mm = rankable.filter((c) => c.program_share > 0.15)
    .sort((a, b) => b.position_pnl - a.position_pnl)[0];
  const failed = state.whales.filter(
    (c) => c.verdict === 'NOT COPYABLE' || c.verdict === 'INSUFFICIENT').length;
  const degen = state.whales.filter((c) => (c.curve_moves ?? 99) < 10).length;

  const p = (html) => { const n = el('p'); n.innerHTML = html; m.appendChild(n); };
  const h = (t) => m.appendChild(el('h3', null, t));

  p(`A profit leaderboard ranks people by an outcome that was partly luck, so being
     top of it does not predict tomorrow. Of <b>${state.whales.length}</b> traders
     checked here, <b>${failed}</b> are ruled out.`);
  if (richest) {
    p(`The current top earner is <b>${escapeHTML(displayName(richest.name, richest.wallet))}</b> at
       <b>${money(richest.position_pnl)}</b> — but <b>${pct(richest.concentration)}</b> of
       that came from a single bet, and only
       <b>${(richest.pct_positive_months ?? 0).toFixed(0)}%</b> of their months were
       profitable. That is a lottery ticket, not a method.`);
  }
  if (mm) {
    p(`<b>${escapeHTML(displayName(mm.name, mm.wallet))}</b> looks steadier —
       <b>${(mm.pct_positive_months ?? 0).toFixed(0)}%</b> winning months. But
       <b>${pct(mm.program_share)}</b> of that profit is rebates for providing liquidity,
       not bets you could copy. They are a market maker: they earn the spread you would
       have to pay.`);
  }

  h('What "worth following" actually means');
  const ul = el('ul');
  [['Profit / historical drop', 'how much they made for every dollar their account fell '
    + 'from its peak. Rewards steadiness, not size.'],
  ['% from one bet', 'if most of the profit came from a single wager, the record is '
    + 'one lucky call rather than a repeatable process.'],
  ['Rebates and rewards', 'money earned for providing liquidity. Real income, but none '
    + 'of it transfers to someone copying the trades.'],
  ['Winning months', 'the cheapest way to tell an edge from a jackpot.']]
    .forEach(([k, v]) => {
      const li = el('li'); li.innerHTML = `<b>${k}</b> — ${v}`; ul.appendChild(li);
    });
  m.appendChild(ul);

  h('Using this for prop-firm research');
  p(`Historical wallet profit is not your account equity or a tested strategy for futures,
     forex or CFDs. These drawdowns use daily samples and can miss intraday losses.
     Profit divided by historical drawdown is not a trade’s reward-to-risk ratio.
     Validate your own entries, stops, costs and exits in forward testing, and track
     your firm’s daily loss, overall drawdown and reset-time rules separately.`);

  h('About copying exits');
  p(`<b>My copies</b> warns you when a whale leaves a position you took. That warning is
     a fact — it is read from Polymarket's records. It is <b>not</b> proof that leaving
     when they leave is profitable. A first simulation of naive copy-in/copy-out on this
     project's own data was dominated by trading fees and by cheap longshots simply held
     to settlement, not by good timing. Treat it as information, not instruction.`);

  h('Two traps this is hardened against');
  p(`<b>Accounts don't start at zero.</b> One trader's history opens already six figures
     down. Measuring their worst drop from the first point we can see would erase that
     loss entirely and make them look risk-free.`);
  p(`<b>Some histories are fake-flat.</b> The API sometimes returns a straight line. No
     movement means no measurable drop, which would rank that trader as infinitely safe.
     <b>${degen}</b> here have such a history and are refused a rating.`);

  h('What this is not');
  p(`It is not a buy signal and there is no trading code in it. A high rating means
     "worth watching closely", not "worth money".`);
}

/* ───────────────────────────── wiring ───────────────────────────────── */

const VIEWS = ['whales', 'trades', 'positions', 'mine', 'soon', 'flows', 'research', 'recap'];
// Seven views grouped into four sections. Closing soon is the default landing:
// it's the owner's stated main use, and it's always populated, where the live
// tape can open on an empty two-minute window.
const TAB_OF = { soon: 'markets', flows: 'markets', trades: 'live', positions: 'live',
  whales: 'whales', research: 'whales', recap: 'recap', mine: 'mine' };
const lastViewOfTab = { markets: 'soon', live: 'trades', whales: 'whales', recap: 'recap', mine: 'mine' };

function showView(view) {
  if (!TAB_OF[view]) view = 'soon';
  const tab = TAB_OF[view];
  lastViewOfTab[tab] = view;
  state.view = view;
  lsSet('whaleLab.view', view);
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  let subs = 0;
  document.querySelectorAll('.sub').forEach((b) => {
    const inTab = b.dataset.tab === tab;
    b.hidden = !inTab;
    if (inTab) subs += 1;
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  $('#subnav').hidden = subs < 2;
  $('#follow-toggle').hidden = view === 'flows' || view === 'mine';
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = view !== v; });
  if (view === 'trades') { state.dirty = true; state.tapeForce = true; }
  if (view === 'positions') renderPositions();
  if (view === 'mine') { renderMine(); pollAllCopies(); }
  if (view === 'soon') renderMarketsSoon();
  if (view === 'flows') renderCryptoFlows();
  if (view === 'research') state.research?.render();
  if (view === 'recap') { state.recapUI?.render(); state.recapUI?.tick(); }
  paintFreshness();
  state.liveRefresh?.tick();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  showView(lastViewOfTab[b.dataset.tab]);
  window.scrollTo({ top: 0 });
}));
document.querySelectorAll('.sub').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// One short line with a coloured dot instead of a four-line paragraph; the full
// caveat stays available as the hover title and in each view's "about" note.
const SNAPSHOT_VIEWS = { whales: 'Scores', research: 'Topic research', flows: 'Transfers', recap: 'Recap' };
function paintFreshness() {
  const box = $('#section-freshness');
  if (!box) return;
  let text, level, title;
  if (SNAPSHOT_VIEWS[state.view]) {
    const ts = { whales: state.meta?.generated_at, research: state.insights?.generated_at,
      flows: state.cryptoFlows?.generated_at, recap: state.recapUI?.generatedAt() }[state.view];
    const age = ts ? Date.now() / 1000 - ts : Infinity;
    level = age < 1800 ? 'ok' : age < 4 * 3600 ? 'stale' : 'old';
    text = ts ? `${SNAPSHOT_VIEWS[state.view]} updated ${ago(ts)} ago` : 'Loading saved data…';
    title = 'Computed by the pipeline on GitHub, not live. Checked for a newer copy every second while this view is open.';
  } else if (state.view === 'trades') {
    level = state.source === 'live' ? 'ok' : 'old';
    text = state.source === 'live' ? 'Live trade feed' : 'Live feed offline · showing saved trades';
    title = 'Trades arrive over the live websocket. Saved-data fallback keeps its original age.';
  } else {
    level = 'ok';
    text = 'Live · refreshing while this view is open';
    title = 'Direct API refresh targets one second. Slow requests, upstream delays and rate limits can extend it; each row shows its own age.';
  }
  box.textContent = text;
  box.title = title;
  box.className = `fresh-line ${level}`;
}

$('#holding-wallet').addEventListener('change', e => {
  state.holdingWallet=e.target.value; renderPositions(); state.liveRefresh?.tick();
});
import('./live.js?v=20260924a').then(({initLive}) => {
  state.liveRefresh=initLive({state,relayURL:relayUrl,categorize:categorizeClient,
    renderPositions,renderMarkets:renderMarketsSoon,checkCopies});
  state.liveRefresh.tick();
}).catch(() => { $('#holdings-live-status').textContent='Live refresh could not load. Reload to retry.'; });

loadWatchlist();
$('#watch-only').checked = state.watchOnly;
$('#watch-count').textContent = `${state.watchlist.size} followed`;
$('#show-screened').hidden = !state.watchOnly;
$('#watch-only').addEventListener('change', e => {
  state.watchOnly = e.target.checked;
  lsSet('whaleWatchOnly.v1', String(state.watchOnly)); refreshWatchlist();
});
$('#show-screened').addEventListener('click', () => {
  state.watchOnly=false; $('#watch-only').checked=false;
  lsSet('whaleWatchOnly.v1','false'); refreshWatchlist();
});
import('./recap.js?v=20260924a').then(({initRecap}) => {
  state.recapUI = initRecap({state, el, displayName, money, ago, snapshotJSON, relayURL: relayUrl,
    marketLink, copyMarketBtn, openDrawer, CAT_LABEL});
  if (state.view === 'recap') { state.recapUI.render(); state.recapUI.tick(); }
}).catch(() => { $('#recap-root').textContent = 'The recap could not load. Reload to retry.'; });
import('./research.js?v=20260924a').then(({initResearch}) => {
  state.research = initResearch({state, displayName, money, ago, watchButton, isWatched,
    snapshotJSON, relayURL:relayUrl, showWhale: openDrawer, refresh: () => { if (state.whales.length) renderBoard(); }});
}).catch(() => { $('#research-status').textContent = 'Research could not load. Reload to retry.'; });

const chipBar = (id, apply) => $(id).addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $(id).querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  apply(b);
});
// Filter/stake changes are the user's own action, so they apply even while
// the tape is holding still for them.
const tapeChanged = () => { state.tapeForce = true; state.dirty = true; };
chipBar('#t-chips', (b) => { state.who = b.dataset.who; tapeChanged(); });
chipBar('#t-cat-chips', (b) => { state.tradeCategory = b.dataset.cat; tapeChanged(); });
chipBar('#p-chips', (b) => { state.posFilter = b.dataset.p; renderPositions(); });
chipBar('#p-cat-chips', (b) => { state.posCategory = b.dataset.cat; renderPositions(); });
chipBar('#w-chips', (b) => { state.verdict = b.dataset.v; renderBoard(); });
chipBar('#w-cat-chips', (b) => { state.category = b.dataset.cat; renderBoard(); });
chipBar('#soon-chips', (b) => { state.marketsBucket = b.dataset.bucket; renderMarketsSoon(); });

$('#w-sort').addEventListener('change', renderBoard);
$('#t-min').addEventListener('input', tapeChanged);
$('#t-stake').addEventListener('input', () => {
  lsSet('mirrorStake', $('#t-stake').value);
  tapeChanged();
});
{
  const saved = lsGet('mirrorStake', null);
  if (saved) $('#t-stake').value = saved;
}

const setPaused = (paused) => {
  state.paused = paused;
  $('#pause').textContent = paused ? 'Resume' : 'Pause';
  $('#pause').classList.toggle('on', paused);
  if (!paused) tapeChanged();
};
$('#pause').addEventListener('click', () => setPaused(!state.paused));

// Hold the tape while a mouse is over it or the floating banner, and for a
// few seconds after a touch. pointerover (not mouseenter on #tape) so moving
// from the list onto the banner doesn't release the hold on the way.
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'mouse') state.tapeHover = !!e.target.closest?.('#tape, #tape-hold');
});
document.documentElement.addEventListener('mouseleave', () => { state.tapeHover = false; });
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' && e.target.closest?.('#tape')) {
    state.tapeTouchUntil = Date.now() + TAPE_TOUCH_HOLD_MS;
  }
}, { passive: true });
$('#tape-hold-show').addEventListener('click', () => {
  if (state.paused) setPaused(false);
  renderTrades({ force: true });
  const top = $('#tape').getBoundingClientRect().top;
  if (top < 0) window.scrollBy({ top: top - 90, behavior: 'smooth' });
});

$('#mine-clear').addEventListener('click', () => {
  if (!state.copies.length) return;
  if (confirm(`Remove all ${state.copies.length} tracked copies? This cannot be undone.`)) {
    state.copies = [];
    saveCopies();
    renderMine();
  }
});
$('#mine-notify').addEventListener('change', (e) => {
  if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
});
$('#mine-method-link').addEventListener('click', (e) => {
  e.preventDefault();
  $('#method-details').open = true;
  $('#method-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#src-btn').addEventListener('click', () => {
  const p = $('#src-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('#relay').value = relayUrl();
});
$('#relay-save').addEventListener('click', () => {
  lsSet('relay', $('#relay').value.trim().replace(/\/+$/, ''));
  location.reload();
});
$('#relay-clear').addEventListener('click', () => {
  try { localStorage.removeItem('relay'); } catch {}
  const url = new URL(location.href); url.searchParams.delete('relay');
  location.href = url.href;
});

$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; });
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') $('#drawer').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#drawer').hidden = true;
});

/* ───────────────────────────── loops ────────────────────────────────── */

setInterval(() => {
  if (!state.dirty) return;
  state.dirty = false;
  if (state.view === 'trades') renderTrades();
  // 'soon' also depends on state.trades (whale-bets cross-reference), so a
  // fresh whale fill should refresh it too, not just the 20s markets_soon poll
  if (state.view === 'soon') renderMarketsSoon();
}, RENDER_MS);

setInterval(() => {
  state.stamps = state.stamps.filter((t) => t > Date.now() - 10_000);
  refreshSourceLabel();
  if (state.view === 'trades') state.dirty = true;
  if (state.view === 'soon') renderMarketsSoon();
  if (state.view === 'positions') renderPositionStats();
  if (state.view === 'recap') state.recapUI?.tick();
  state.liveRefresh?.tick();
  paintFreshness();
}, 1000);

setInterval(() => {
  if (document.hidden) return;
  if (state.view==='whales') loadWhales();
  if (state.view==='trades') loadSnapshot();
  if (state.view==='positions'||state.view==='mine') loadPositions();
  if (state.view==='soon') loadMarketsSoon();
  if (state.view==='flows') loadCryptoFlows();
}, REFRESH_POLL_MS);
setInterval(loadWhales,60_000);

// The actual fix for "goes blank": poll every tracked copy directly and
// continuously, independent of the once-per-15-30-minute board rebuild. Runs
// regardless of which tab is open (an exit while you're on Live buys should
// still update the badge), just skips the DOM repaint unless you're looking.
setInterval(() => { if (!document.hidden && state.copies.length) pollAllCopies(); }, COPY_POLL_MS);

// Back the moment the tab is looked at again or the network returns, instead of
// waiting out the 30 s retry (see onWsDead).
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
window.addEventListener('online', reconnectNow);

loadCopies();
updateMineBadge();
// A #view in the address (…/polymarket-lab/#recap) opens that view, so a
// section can be bookmarked; otherwise the last view used comes back.
showView(TAB_OF[location.hash.slice(1)] ? location.hash.slice(1) : lsGet('whaleLab.view', 'soon'));
loadWhales().then(() => Promise.all([loadSnapshot(), loadPositions()])).then(connect);
if (state.copies.length) pollAllCopies();
loadMarketsSoon();

loadCryptoFlows();
