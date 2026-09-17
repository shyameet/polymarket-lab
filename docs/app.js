/* Polymarket Whale Lab — front end.
 *
 * THREE DATA SOURCES, TRIED IN ORDER
 * ----------------------------------
 *   relay     a Cloudflare Worker that pipes Polymarket's websocket. Works on
 *             any network, including ones that cannot resolve polymarket.com.
 *   direct    the browser's own websocket to Polymarket. Sub-second, but dies
 *             wherever the polymarket.com DNS zone is sinkholed.
 *   snapshot  data/*.json, committed by the scheduled job. Always available,
 *             never live -- GitHub throttles cron on free public repos and the
 *             observed gap between runs reached 245 minutes.
 *
 * Whichever is in use is stated in the header, with its real age. Nothing here
 * is a hardcoded statistic: every number is computed from whatever data is
 * actually loaded, so the page cannot drift away from reality.
 *
 * THREE VIEWS
 * -----------
 *   Trades     the live/near-live fill tape, decluttered to what you need to
 *              act on a fill: who, what, price, and what mirroring it at your
 *              own stake would look like.
 *   Positions  what screened whales are CURRENTLY HOLDING and what they
 *              RECENTLY EXITED, read from Polymarket's own position ledger.
 *              This is the honest answer to "when do I get out" -- it shows
 *              you what happened, it does not claim that mirroring it is
 *              proven profitable (see the Method section).
 *   Whales     the scored board: who passed the screen, sortable by all-time
 *              risk-adjusted return or by the official day/week leaderboard,
 *              filterable by category.
 */

const DIRECT_WS = 'wss://ws-live-data.polymarket.com';
const REFRESH_POLL_MS = 20_000;   // how often the snapshot/positions files are re-pulled
const RENDER_MS = 2200;           // deliberately slow -- see the user's "goes too fast" note
const MAX_ROWS = 150;
const DIRECT_MAX_FAILS = 3;

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
  snapshotMeta: null, meta: null,
  source: 'starting', via: 'direct', paused: false, dirty: true,
  stamps: [], directFails: 0, ws: null, backoff: 1000, pinger: null,
  view: 'trades', who: 'best', verdict: 'good', category: '', posFilter: 'all',
  hintShown: false,
};

/* ─────────────────────────── format helpers ─────────────────────────── */

const money = (v, forceCents = false) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a < 100 || forceCents) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toFixed(0)}`;
};
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut');
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const isChurn = (t) =>
  /Up or Down|updown-\d+m/i.test(`${t.title || ''} ${t.slug || ''}`);
// Polymarket combo/parlay bets AND several independent markets into one
// wager -- e.g. "Team A win AND Team B win AND Team C draw". Those have no
// single outcome (the field comes back empty) and cannot be mirrored as a
// simple single-market trade, so they need their own handling, not a "?"
// placeholder and a misleading share count.
const isCombo = (t) => !t.outcome && / AND /.test(t.title || '');
const CAT_LABEL = { crypto: 'Crypto', sports: 'Sports', politics: 'Politics',
                   macro: 'Macro', other: 'Other' };

const marketLink = (title, slug) => {
  const a = el('a', null, title || slug || '—');
  if (slug) { a.href = `https://polymarket.com/event/${slug}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};

/* ─────────────────────────── relay config ───────────────────────────── */

const relayUrl = () => {
  const q = new URLSearchParams(location.search).get('relay');
  if (q) { lsSet('relay', q); return q.replace(/\/+$/, ''); }
  return (lsGet('relay', '') || '').replace(/\/+$/, '');
};

/* ────────────────────────── source indicator ────────────────────────── */

function setSource(kind, detail) {
  state.source = kind;
  const dot = $('#dot'), txt = $('#live-text');
  dot.className = `dot ${{ live: 'on', snapshot: 'warn', down: 'off' }[kind] || ''}`;
  txt.textContent = detail;
}

function refreshSourceLabel() {
  if (state.source === 'live') {
    setSource('live', `LIVE · ${(state.stamps.length / 10).toFixed(0)}/s · ${state.via}`);
  } else if (state.source === 'snapshot') {
    const ts = state.snapshotMeta?.newest_ts;
    setSource('snapshot', ts ? `SNAPSHOT · ${ago(ts)} old` : 'SNAPSHOT');
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
    tx: raw.tx || raw.transactionHash || '',
    live: !!live,
  };
  if (!t.wallet || !t.side) return false;

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

  // A socket pointed at a sinkholed address can hang for over a minute before
  // the OS gives up. Judge it ourselves.
  const openTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      try { ws.close(); } catch {}   // triggers onclose -> onWsDead
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(openTimer);
    state.backoff = 1000;
    state.directFails = 0;
    // The relay auto-subscribes; a direct socket must send the frame itself.
    if (!relay) {
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'activity', type: 'trades' }],
      }));
    }
    setSource('live', `LIVE · ${state.via}`);
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
        if (!state.paused) addTrade(p, true);
      }
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(openTimer);
    clearInterval(state.pinger);
    onWsDead();
  };
}

function onWsDead() {
  state.directFails += 1;
  const relay = relayUrl();

  // A sinkholed DNS zone does not heal on a backoff timer. Fall back to the
  // committed snapshot rather than retrying forever, and say why.
  if (!relay && state.directFails >= DIRECT_MAX_FAILS) {
    state.source = 'snapshot';
    refreshSourceLabel();
    $('#src-status').textContent =
      'Direct connection to Polymarket failed — usually DNS. Showing the committed '
      + 'snapshot instead. Add a relay below, or set your DNS to 1.1.1.1, for live data.';
    if (!state.hintShown) { state.hintShown = true; $('#src-panel').hidden = false; }
    return;
  }
  if (relay && state.directFails >= DIRECT_MAX_FAILS + 3) {
    state.source = 'snapshot';
    refreshSourceLabel();
    $('#src-status').textContent = `Relay ${relay} is not responding. Check it is deployed.`;
    $('#src-panel').hidden = false;
    return;
  }
  setTimeout(connect, state.backoff);
  state.backoff = Math.min(state.backoff * 2, 15_000);
}

/* ─────────────────────────── data loading ───────────────────────────── */

async function loadWhales() {
  try {
    const [w, m] = await Promise.all([
      fetch('data/whales.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
    ]);
    state.whales = Array.isArray(w) ? w : [];
    state.byWallet = new Map(state.whales.map((c) => [(c.wallet || '').toLowerCase(), c]));
    state.meta = m;
    renderBoard();
    renderMethod();
  } catch (e) { console.error('whales', e); }
}

async function loadSnapshot() {
  try {
    const f = await fetch('data/whale_trades.json', { cache: 'no-cache' })
      .then((r) => r.json());
    if (!f?.trades) return;
    state.snapshotMeta = f;
    for (const t of f.trades) addTrade(t, false);
    // Report what we HAVE straight away. A browser websocket aimed at a
    // blackholed IP can take ~75 seconds to fail, and sitting on "starting..."
    // for that long reads as broken when the data is already on screen.
    if (state.source !== 'live') {
      state.source = 'snapshot';
      refreshSourceLabel();
    }
  } catch { /* mid-deploy; the next tick retries */ }
}

async function loadPositions() {
  try {
    const p = await fetch('data/whale_positions.json', { cache: 'no-cache' })
      .then((r) => r.json());
    if (!p) return;
    state.positions = { open: p.open || [], recently_closed: p.recently_closed || [] };
    state.posMeta = p;
    if (state.view === 'positions') renderPositions();
  } catch { /* mid-deploy; the next tick retries */ }
}

/* ──────────────────────────── trades view ───────────────────────────── */

function visibleTrades() {
  const min = Number($('#t-min').value) || 0;
  return state.trades
    .filter((t) => {
      if (t.usd < min) return false;
      if (state.who === 'best')
        return t.verdict === 'CANDIDATE' || t.verdict === 'WATCH';
      if (state.who === 'all') return !!t.verdict;
      return !isChurn(t);   // "everyone" still drops 5-minute crypto churn
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ROWS);
}

function renderTrades() {
  const rows = visibleTrades();
  const list = $('#tape');
  const empty = $('#tape-empty');
  const stake = Number($('#t-stake').value) || 25;

  if (!rows.length) {
    list.textContent = '';
    empty.hidden = false;
    empty.textContent = state.trades.length
      ? `No fills match — ${state.trades.length} loaded, all filtered out. `
        + 'Lower "min $" or widen the selection.'
      : (state.source === 'live' ? 'Connected. Waiting for fills…' : 'Loading…');
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const t of rows) {
    const fresh = t.live && (Date.now() / 1000 - t.ts) < 90;
    const li = el('li', `row${fresh ? ' fresh' : ''}`);

    const who = el('div', 'who');
    const nm = el('span', 'nm', t.name || short(t.wallet));
    const card = state.byWallet.get(t.wallet);
    if (card) nm.addEventListener('click', () => openDrawer(card));
    who.appendChild(nm);
    if (t.verdict) {
      who.appendChild(el('span',
        `v v-${t.verdict === 'NOT COPYABLE' ? 'NOT' : t.verdict}`, t.verdict));
    }
    if (t.discovered) who.appendChild(el('span', 'tag', 'OFF-BOARD'));
    li.appendChild(who);

    const combo = isCombo(t);
    const mid = el('div');
    mid.style.cssText = 'font-size:13px;color:var(--dim)';
    mid.appendChild(el('span', `side ${t.side}`, t.side));
    mid.appendChild(document.createTextNode(
      combo ? ' combo bet' : ` ${t.outcome || ''} @ ${t.price.toFixed(3)}`));
    if (combo) mid.appendChild(el('span', 'tag', 'MULTI-LEG'));
    li.appendChild(mid);

    const right = el('div');
    right.style.textAlign = 'right';
    right.appendChild(el('div', 'amt', money(t.usd)));
    right.appendChild(el('div', 'when', `${ago(t.ts)} ago`));
    li.appendChild(right);

    const mk = el('div', 'mkt');
    mk.appendChild(marketLink(t.title, t.slug));
    li.appendChild(mk);

    // The one thing that answers "how much should I have bet": a flat mirror
    // stake (not scaled to the whale's size -- their $50k bet is not a signal
    // that YOU should bet $50k) sized against the price on this print. This is
    // the price they got, not the price a delayed follower would actually get
    // -- said plainly, not left implied.
    //
    // Combo bets get their own message rather than a share count: Polymarket
    // lets you AND several independent markets into one wager, there is no
    // single "outcome" to buy shares of, and a real follower cannot cheaply
    // reconstruct someone else's specific N-leg parlay.
    if (combo) {
      const mirror = el('div', 'mirror',
        'combo bet across multiple markets — not something a single mirror trade can reproduce');
      li.appendChild(mirror);
    } else if (t.price > 0 && t.price < 1) {
      const shares = stake / t.price;
      const mirror = el('div', 'mirror');
      mirror.innerHTML = `mirror @ $${stake}: <b>~${shares.toFixed(shares < 10 ? 1 : 0)} sh</b> `
        + `of "${t.outcome}" — at THEIR price; arriving late you would likely pay more`;
      li.appendChild(mirror);
    }

    frag.appendChild(li);
  }
  list.textContent = '';
  list.appendChild(frag);
}

/* ─────────────────────────── positions view ──────────────────────────── */

function visiblePositions() {
  const { open, recently_closed } = state.positions;
  if (state.posFilter === 'open') return { open, closed: [] };
  if (state.posFilter === 'closed') return { open: [], closed: recently_closed };
  return { open, closed: recently_closed };
}

function renderPositions() {
  const { open, closed } = visiblePositions();
  const list = $('#positions');
  const empty = $('#positions-empty');
  list.textContent = '';

  renderPositionStats();

  const rows = [...open.map((p) => ({ ...p, _open: true })),
                ...closed.map((p) => ({ ...p, _open: false }))];
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.posMeta ? 'Nothing to show for this filter.' : 'Loading…';
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const li = el('li', 'row poscard');

    const who = el('div', 'who');
    const nm = el('span', 'nm', p.name || short(p.wallet));
    const card = state.byWallet.get((p.wallet || '').toLowerCase());
    if (card) nm.addEventListener('click', () => openDrawer(card));
    who.appendChild(nm);
    if (p.verdict) {
      who.appendChild(el('span',
        `v v-${p.verdict === 'NOT COPYABLE' ? 'NOT' : p.verdict}`, p.verdict));
    }
    li.appendChild(who);

    li.appendChild(el('span', `pstatus ${p._open ? 'open' : 'exited'}`,
      p._open ? 'STILL IN' : 'EXITED'));

    const mk = el('div', 'mkt');
    mk.appendChild(marketLink(p.title, p.slug));
    if (p.outcome) mk.appendChild(document.createTextNode(`  ·  ${p.outcome}`));
    li.appendChild(mk);

    const meta = el('div', 'pmeta');
    const bit = (label, val) => {
      const s = el('span', null, `${label} `);
      s.appendChild(el('b', null, val));
      meta.appendChild(s);
    };
    bit('entry', p.avg_price != null ? `$${Number(p.avg_price).toFixed(3)}` : '—');
    if (p._open) {
      bit('now', p.current_price != null ? `$${Number(p.current_price).toFixed(3)}` : '—');
      bit('unrealized', money(p.unrealized_pnl));
      bit('since', `${ago(p.last_event_at)} ago`);
    } else {
      bit('realized', money(p.realized_pnl));
      bit('exited', `${ago(p.last_event_at)} ago`);
    }
    if (p.likely_hedge_residue) {
      meta.appendChild(el('span', 'hedge-flag',
        'possible hedge residue, not a chosen price'));
    }
    li.appendChild(meta);

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
  add('currently holding', String(state.positions.open.length));
  add('exited (7d)', String(state.positions.recently_closed.length));
  if (state.posMeta?.generated_at) add('refreshed', `${ago(state.posMeta.generated_at)} ago`);
}

/* ──────────────────────────── whales view ───────────────────────────── */

const ORDER = { CANDIDATE: 0, WATCH: 1, FRAGILE: 2, 'NOT COPYABLE': 3, INSUFFICIENT: 4 };
const isGood = (c) => c.verdict === 'CANDIDATE' || c.verdict === 'WATCH';

function renderBoard() {
  const sortKey = $('#w-sort').value;
  let rows = state.whales.filter((c) => {
    if (state.verdict === 'good' && !isGood(c)) return false;
    if (state.verdict && state.verdict !== 'good' && c.verdict !== state.verdict) return false;
    if (state.category && c.category !== state.category) return false;
    return true;
  });

  const hint = $('#w-sort-hint');
  if (sortKey === 'lb_day_pnl' || sortKey === 'lb_week_pnl') {
    const have = rows.filter((c) => c[sortKey] != null).length;
    hint.hidden = false;
    hint.textContent = `${have} of ${rows.length} shown wallets appeared on that leaderboard `
      + `window; the rest sort to the bottom. This is Polymarket's own raw number, `
      + `not re-verified by the screen.`;
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
      return sortKey === 'max_dd_usd' ? av - bv : bv - av;
    });
  }

  const list = $('#board');
  list.textContent = '';
  $('#board-empty').hidden = rows.length > 0;
  renderBoardStats(rows);

  const frag = document.createDocumentFragment();
  rows.slice(0, 200).forEach((c, i) => {
    const li = el('li', 'row');
    li.appendChild(el('div', 'rank', String(i + 1)));

    const who = el('div', 'who');
    const nm = el('span', 'nm', c.name || short(c.wallet));
    nm.addEventListener('click', () => openDrawer(c));
    who.appendChild(nm);
    if (c.category) who.appendChild(el('span', 'tag', CAT_LABEL[c.category] || c.category));
    if (c.discovered) who.appendChild(el('span', 'tag', 'OFF-BOARD'));
    li.appendChild(who);

    const amtVal = (sortKey === 'lb_day_pnl' || sortKey === 'lb_week_pnl')
      && c[sortKey] != null ? c[sortKey] : c.position_pnl;
    li.appendChild(el('div', `amt ${sign(amtVal)}`, money(amtVal)));
    li.appendChild(el('span',
      `v v-${c.verdict === 'NOT COPYABLE' ? 'NOT' : c.verdict}`, c.verdict));

    const m = el('div', 'metrics');
    const bit = (label, val) => {
      const s = el('span', null, `${label} `);
      s.appendChild(el('b', null, val));
      m.appendChild(s);
    };
    bit('max DD', money(c.max_dd_usd));
    bit('net/DD', c.net_dd == null ? '—' : c.net_dd.toFixed(1));
    bit('months +', `${(c.pct_positive_months ?? 0).toFixed(0)}%`);
    bit('fills', (c.trade_count || 0).toLocaleString());
    if (c.lb_day_pnl != null) bit('today', money(c.lb_day_pnl));
    if (c.lb_week_pnl != null) bit('this wk', money(c.lb_week_pnl));
    li.appendChild(m);

    if (c.flags?.length) {
      li.appendChild(el('div', 'why',
        c.flags[0] + (c.flags.length > 1 ? `  (+${c.flags.length - 1} more)` : '')));
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
  add('scored', String(state.whales.length));
  add('worth watching', String((v.CANDIDATE || 0) + (v.WATCH || 0)));
  add('shown now', String(rows.length));
  add('off-leaderboard', String(state.whales.filter((c) => c.discovered).length));
  if (state.meta?.generated_at) add('refreshed', `${ago(state.meta.generated_at)} ago`);
}

/* ───────────────────────────── drawer ───────────────────────────────── */

function openDrawer(c) {
  const b = $('#drawer-body');
  b.textContent = '';
  b.appendChild(el('h2', 'dh', c.name || short(c.wallet)));
  b.appendChild(el('p', 'dsub', c.wallet));
  b.appendChild(el('span',
    `v v-${c.verdict === 'NOT COPYABLE' ? 'NOT' : c.verdict}`, c.verdict));
  if (c.category) {
    const t = el('span', 'tag', `mostly ${CAT_LABEL[c.category] || c.category}`);
    t.style.marginLeft = '8px';
    b.appendChild(t);
  }

  const grid = el('div', 'grid');
  const cell = (k, v, cls) => {
    const d = el('div', 'cell');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', `val ${cls || ''}`, v));
    grid.appendChild(d);
  };
  cell('Profit', money(c.position_pnl), sign(c.position_pnl));
  cell('Max drawdown', money(c.max_dd_usd), 'neg');
  cell('Net / DD', c.net_dd == null ? '—' : c.net_dd.toFixed(2));
  cell('Realized trading', money(c.realized_market_pnl), sign(c.realized_market_pnl));
  cell('Unrealized', money(c.unrealized_pnl), sign(c.unrealized_pnl));
  cell('Rebates / rewards', money(c.program_income), 'mut');
  cell('Biggest win', money(c.biggest_win));
  cell('Concentration', pct(c.concentration));
  cell('Volume', money(c.volume_usdc));
  cell('Edge per $', c.edge_per_dollar == null ? '—' : pct(c.edge_per_dollar, 2));
  cell('Fees paid', money(c.fees_paid), 'neg');
  cell('Fills', (c.trade_count || 0).toLocaleString());
  cell('Months positive', `${(c.pct_positive_months ?? 0).toFixed(0)}%`);
  if (c.lb_day_pnl != null) cell('Today (leaderboard)', money(c.lb_day_pnl), sign(c.lb_day_pnl));
  if (c.lb_week_pnl != null) cell('This week (leaderboard)', money(c.lb_week_pnl), sign(c.lb_week_pnl));
  cell('Curve days', String(c.curve_days ?? '—'));
  cell('Idle days', c.days_idle == null ? '—' : String(c.days_idle));
  b.appendChild(grid);

  const openPos = state.positions.open.filter(
    (p) => (p.wallet || '').toLowerCase() === (c.wallet || '').toLowerCase());
  const closedPos = state.positions.recently_closed.filter(
    (p) => (p.wallet || '').toLowerCase() === (c.wallet || '').toLowerCase());
  if (openPos.length || closedPos.length) {
    b.appendChild(el('div', 'sec', 'Positions right now'));
    for (const p of openPos.slice(0, 5)) {
      const row = el('div');
      row.style.cssText = 'font-size:12.5px;color:var(--dim);margin-bottom:4px';
      row.innerHTML = `<span class="pstatus open">STILL IN</span> `
        + `${p.title || ''} — entry $${(p.avg_price ?? 0).toFixed(3)}, `
        + `unrealized ${money(p.unrealized_pnl)}`;
      b.appendChild(row);
    }
    for (const p of closedPos.slice(0, 5)) {
      const row = el('div');
      row.style.cssText = 'font-size:12.5px;color:var(--dim);margin-bottom:4px';
      row.innerHTML = `<span class="pstatus exited">EXITED</span> `
        + `${p.title || ''} — realized ${money(p.realized_pnl)}, ${ago(p.last_event_at)} ago`;
      b.appendChild(row);
    }
  }

  if (c.flags?.length) {
    b.appendChild(el('div', 'sec', 'Why it scored this way'));
    const ul = el('ul', 'flags');
    c.flags.forEach((f) => ul.appendChild(el('li', null, f)));
    b.appendChild(ul);
  }

  if (c.monthly?.length) {
    b.appendChild(el('div', 'sec', 'Monthly P&L'));
    const max = Math.max(...c.monthly.map((m) => Math.abs(m.pnl)), 1);
    const bars = el('div', 'bars');
    c.monthly.forEach((m) => {
      const bar = el('div', `b ${m.pnl >= 0 ? 'up' : 'dn'}`);
      bar.style.height = `${Math.max(2, (Math.abs(m.pnl) / max) * 100)}%`;
      bar.title = `${m.month}: ${money(m.pnl)}`;
      bars.appendChild(bar);
    });
    b.appendChild(bars);
    const ax = el('div', 'axis');
    ax.appendChild(el('span', null, c.monthly[0].month));
    ax.appendChild(el('span', null, c.monthly[c.monthly.length - 1].month));
    b.appendChild(ax);
  }

  const link = el('a', null, 'Open profile on Polymarket ↗');
  link.href = `https://polymarket.com/profile/${c.wallet}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.style.cssText = 'display:inline-block;margin-top:22px;color:var(--blue)';
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
  const best = rankable.filter((c) => c.verdict === 'CANDIDATE')
    .sort((a, b) => (b.net_dd ?? 0) - (a.net_dd ?? 0))[0];
  const failed = state.whales.filter(
    (c) => c.verdict === 'NOT COPYABLE' || c.verdict === 'INSUFFICIENT').length;
  const degen = state.whales.filter((c) => (c.curve_moves ?? 99) < 10).length;

  const p = (html) => { const n = el('p'); n.innerHTML = html; m.appendChild(n); };
  const h = (t) => m.appendChild(el('h3', null, t));

  p(`A profit leaderboard is a <b>sorted in-sample pool</b>. It ranks people by an
     outcome that was partly luck, and rank on such a pool carries no forward
     information. Of <b>${state.whales.length}</b> wallets scored here,
     <b>${failed}</b> fail the screen.`);

  if (richest) {
    p(`The current top earner is <b>${richest.name || short(richest.wallet)}</b> at
       <b>${money(richest.position_pnl)}</b> — of which
       <b>${pct(richest.concentration)}</b> came from a single position, over
       <b>${(richest.trade_count || 0).toLocaleString()}</b> fills, with
       <b>${(richest.pct_positive_months ?? 0).toFixed(0)}%</b> of months positive
       and a <b>${money(richest.max_dd_usd)}</b> peak-to-trough.`);
  }
  if (mm) {
    p(`<b>${mm.name || short(mm.wallet)}</b> looks better on consistency —
       <b>${(mm.pct_positive_months ?? 0).toFixed(0)}%</b> of months positive over
       <b>${(mm.trade_count || 0).toLocaleString()}</b> fills. But
       <b>${pct(mm.program_share)}</b> of that profit is rebates and liquidity
       rewards at a <b>${pct(mm.edge_per_dollar, 1)}</b> edge per dollar traded:
       a market maker. You cannot follow someone into a quote.`);
  }
  if (best) {
    p(`The best <i>screened</i> wallet is <b>${best.name || short(best.wallet)}</b> —
       net/drawdown <b>${(best.net_dd ?? 0).toFixed(1)}</b>,
       <b>${(best.pct_positive_months ?? 0).toFixed(0)}%</b> of months positive,
       concentration <b>${pct(best.concentration)}</b>${best.discovered
      ? ', and it appears on <b>no leaderboard</b> — it was found by walking the top '
        + 'holders of liquid markets' : ''}.`);
  }

  h('What is scored');
  const ul = el('ul');
  [['Net / max drawdown', 'profit per dollar of peak-to-trough pain, measured on a '
    + 'mark-inclusive curve so open-position pain counts'],
  ['Concentration', 'share of lifetime profit from the single best position — one '
    + 'bet, or a process?'],
  ['Rebates and rewards', 'money that accrues to market-making, none of which '
    + 'transfers to someone copying the trades'],
  ['Edge per dollar traded', 'above ~20% is a concentrated directional bettor; below '
    + '~3% on huge volume is a spread grinder'],
  ['Months positive', 'the cheapest separator between an edge and a jackpot']]
    .forEach(([k, v]) => {
      const li = el('li');
      li.innerHTML = `<b>${k}</b> — ${v}`;
      ul.appendChild(li);
    });
  m.appendChild(ul);

  h('Positions and exits');
  p(`The <b>Positions</b> tab shows what each screened whale is currently holding
     and what they exited in roughly the last week, read from Polymarket's own
     ledger. The default rule offered there is <b>exit when they exit</b> —
     that is real, checkable data. It is <b>not yet proven to be the right
     rule</b>: a first pass at simulating naive entry/exit mirroring on this
     project's own fill tape was dominated by fee drag and by longshot
     positions that were simply held to resolution rather than by genuine
     timing skill. Treat the Positions tab as visibility, not a signal.`);

  h('Today / this week / by category');
  p(`The Whales board can sort by Polymarket's own day and week leaderboard
     PnL, and filter by the category a wallet mostly trades (crypto, sports,
     politics, macro) inferred from their recent fills. These are useful for
     finding who is active RIGHT NOW, but they are a shorter, noisier sample
     than the all-time screen — a wallet can have a great day by luck alone.`);

  h('Two traps it is hardened against');
  p(`<b>The equity curve does not start at zero.</b> One wallet's series opens
     already six figures down, so seeding the high-water mark at the first
     observation erases its entire inception drawdown and reports a riskless-looking
     <code>max DD = $0</code>.`);
  p(`<b>Some curves are fake.</b> The API sometimes back-fills a flat line. Zero
     variance means zero drawdown means an <i>infinite</i> net/DD, which sorts
     straight to the top of a risk-first ranking. <b>${degen}</b> of the wallets
     here have such a curve and are refused a rank.`);

  h('What this is not');
  p(`It is not a buy signal, and there is no execution code anywhere in it. A high
     rank means "worth forward-testing", not "worth money". Past PnL rank has no
     demonstrated forward information, and the honest next step is to track a
     shortlist forward and find out.`);
}

/* ───────────────────────────── wiring ───────────────────────────────── */

document.querySelectorAll('.segbtn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.segbtn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.view = b.dataset.view;
  $('#view-trades').hidden = state.view !== 'trades';
  $('#view-positions').hidden = state.view !== 'positions';
  $('#view-whales').hidden = state.view !== 'whales';
  if (state.view === 'trades') state.dirty = true;
  if (state.view === 'positions') renderPositions();
}));

$('#t-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('#t-chips').querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.who = b.dataset.who;
  state.dirty = true;
});

$('#p-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('#p-chips').querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.posFilter = b.dataset.p;
  renderPositions();
});

$('#w-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('#w-chips').querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.verdict = b.dataset.v;
  renderBoard();
});

$('#w-cat-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('#w-cat-chips').querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.category = b.dataset.cat;
  renderBoard();
});

$('#w-sort').addEventListener('change', renderBoard);
$('#t-min').addEventListener('input', () => { state.dirty = true; });
$('#t-stake').addEventListener('input', () => {
  lsSet('mirrorStake', $('#t-stake').value);
  state.dirty = true;
});
{
  const saved = lsGet('mirrorStake', null);
  if (saved) $('#t-stake').value = saved;
}

$('#pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('#pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('#pause').classList.toggle('on', state.paused);
});

$('#pos-method-link')?.addEventListener('click', (e) => {
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
  const v = $('#relay').value.trim().replace(/\/+$/, '');
  lsSet('relay', v);
  location.reload();
});
$('#relay-clear').addEventListener('click', () => {
  try { localStorage.removeItem('relay'); } catch {}
  location.reload();
});

$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; });
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') $('#drawer').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#drawer').hidden = true;
});

/* ───────────────────────────── loops ────────────────────────────────── */

// Repaint on a timer rather than per message: at ~28 fills/sec a per-message
// render would thrash the DOM, and at 700ms it still read as "too fast" --
// 2.2s gives a calmer, readable cadence without feeling stale.
setInterval(() => {
  if (state.dirty && state.view === 'trades') { state.dirty = false; renderTrades(); }
}, RENDER_MS);

// Keep relative timestamps and the rate honest even when nothing arrives.
setInterval(() => {
  const cut = Date.now() - 10_000;
  state.stamps = state.stamps.filter((t) => t > cut);
  refreshSourceLabel();
  if (state.view === 'trades') state.dirty = true;
}, 1000);

setInterval(() => { loadSnapshot(); loadPositions(); }, REFRESH_POLL_MS);

loadWhales().then(() => Promise.all([loadSnapshot(), loadPositions()])).then(connect);
