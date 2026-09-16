/* Polymarket Whale Lab — front end.
 *
 * Runs entirely in the browser. There is no backend: Polymarket's read APIs all
 * send `access-control-allow-origin: *`, so a static page can talk to them
 * directly, and the activity socket is unauthenticated. The scorecards are
 * pre-computed by a scheduled job because they need ~4 calls per wallet.
 *
 * REST is NOT live — every REST response is CDN-cached max-age=300, so anything
 * fetched over HTTP here can be up to 5 minutes stale. Only the socket is live.
 */

const WS_URL = 'wss://ws-live-data.polymarket.com';
const MAX_TAPE_ROWS = 300;     // DOM rows; the feed runs ~43/sec
const RATE_WINDOW_MS = 10_000;

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (txt != null) n.textContent = txt;
  return n;
};

const state = {
  whales: [],
  byWallet: new Map(),
  paused: false,
  tape: [],
  stamps: [],
  notified: new Set(),
  feed: [],
  wsFails: 0,
};

/* ───────────────────────────── formatting ───────────────────────────── */

const money = (v, d = 0) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  // sub-$100 needs cents: deep-longshot fills land at fractions of a dollar and
  // rounding them to "$0" reads as a broken cell rather than as a small trade
  if (a < 100 && d === 0) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toFixed(d)}`;
};
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut');

/* ───────────────────────────── data load ────────────────────────────── */

async function loadData() {
  try {
    const [w, m, f] = await Promise.all([
      fetch('data/whales.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
      fetch('data/whale_trades.json', { cache: 'no-cache' }).then((r) => r.json())
        .catch(() => null),
    ]);
    state.feed = f?.trades || [];
    state.whales = Array.isArray(w) ? w : [];
    state.whales.forEach((c) => state.byWallet.set((c.wallet || '').toLowerCase(), c));

    if (m?.generated_at) {
      const age = Math.round((Date.now() / 1000 - m.generated_at) / 60);
      $('#built').textContent = `scored ${m.wallets_scored} wallets · ${
        age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`}`;
    }
    if (m?.verdicts) {
      const v = m.verdicts;
      const total = Object.values(v).reduce((a, b) => a + b, 0);
      const bad = (v['NOT COPYABLE'] || 0) + (v.INSUFFICIENT || 0);
      $('#callout-stats').textContent =
        `${bad} of ${total} scored wallets failed the screen — ` +
        `${v.CANDIDATE || 0} candidate, ${v.WATCH || 0} watch, ` +
        `${v.FRAGILE || 0} fragile, ${v['NOT COPYABLE'] || 0} not copyable, ` +
        `${v.INSUFFICIENT || 0} insufficient history.`;
    }
    renderBoard();
    renderTrades(f);
  } catch (e) {
    $('#board-empty').hidden = false;
    $('#board-empty').textContent =
      'Could not load data/whales.json — run the pipeline to generate it.';
    console.error(e);
  }
}

/* ───────────────────────────── whale board ──────────────────────────── */

function renderBoard() {
  const sortKey = $('#sort').value;
  const wantVerdict = $('#f-verdict').value;
  const onlyRankable = $('#f-rankable').checked;
  const onlyDisc = $('#f-disc').checked;

  let rows = state.whales.filter((c) => {
    if (wantVerdict && c.verdict !== wantVerdict) return false;
    if (onlyRankable && !c.rankable) return false;
    if (onlyDisc && !c.discovered) return false;
    return true;
  });

  // Unrankable wallets always sink to the bottom regardless of sort key.
  // Their metrics exist but are not trustworthy enough to interleave with
  // wallets that have a real, moving equity curve.
  // Screen rank is the default because a raw Net/DD sort puts MARKET MAKERS
  // on top -- they genuinely have the best risk-adjusted numbers (Net/DD 271,
  // 227, 38 on this dataset) and are genuinely uncopyable. Ordering by verdict
  // first surfaces what you could actually act on, without hiding the rest.
  const VERDICT_ORDER = {
    CANDIDATE: 0, WATCH: 1, FRAGILE: 2, 'NOT COPYABLE': 3, INSUFFICIENT: 4,
  };
  rows.sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    if (sortKey === 'screen') {
      const d = (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9);
      if (d) return d;
      return (b.net_dd ?? -Infinity) - (a.net_dd ?? -Infinity);
    }
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortKey === 'max_dd_usd' ? av - bv : bv - av;  // low DD is better
  });

  const body = $('#board-body');
  body.textContent = '';
  $('#board-empty').hidden = rows.length > 0;
  $('#board-count').textContent = `${rows.length} wallets`;

  rows.forEach((c, i) => {
    const tr = el('tr');
    tr.appendChild(el('td', 'mut', String(i + 1)));

    const who = el('td');
    const box = el('div', 'who');
    box.appendChild(el('span', 'dot'));
    const nm = el('b', null, c.name || short(c.wallet));
    box.appendChild(nm);
    if (c.discovered) box.appendChild(el('span', 'badge-disc', 'OFF-BOARD'));
    who.appendChild(box);
    who.appendChild(el('div', 'addr', short(c.wallet)));
    tr.appendChild(who);

    const vd = el('td');
    const chip = el('span', `v v-${c.verdict === 'NOT COPYABLE' ? 'NOT' : c.verdict}`,
      c.verdict);
    vd.appendChild(chip);
    tr.appendChild(vd);

    const add = (txt, cls) => {
      const td = el('td', `num ${cls || ''}`, txt);
      tr.appendChild(td);
    };
    add(money(c.position_pnl), signClass(c.position_pnl));
    add(money(c.max_dd_usd), c.max_dd_usd > 0 ? 'neg' : 'mut');
    add(c.net_dd == null ? '—' : num(c.net_dd), c.net_dd == null ? 'mut' : '');
    add(c.pct_positive_months != null ? `${c.pct_positive_months.toFixed(0)}%` : '—');
    add(pct(c.concentration));
    add(c.edge_per_dollar == null ? '—' : pct(c.edge_per_dollar, 1));
    add(c.trade_count ? c.trade_count.toLocaleString() : '—');

    const why = el('td', 'why');
    if (c.flags?.length) {
      why.textContent = c.flags[0].split(':')[0];
      if (c.flags.length > 1) {
        why.appendChild(document.createTextNode(` +${c.flags.length - 1}`));
      }
    } else {
      why.appendChild(el('span', 'mut', '—'));
    }
    tr.appendChild(why);

    const act = el('td');
    const btn = el('button', 'more', 'detail');
    btn.addEventListener('click', () => openDrawer(c));
    act.appendChild(btn);
    tr.appendChild(act);

    body.appendChild(tr);
  });
}

/* ──────────────────────── whale trades (server-side) ────────────────────── */

const ago = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function renderTrades(meta) {
  if (meta !== undefined) state.feedMeta = meta;
  meta = state.feedMeta;
  const body = $('#trades-body');
  const empty = $('#trades-empty');
  if (!body) return;

  if (!state.feed.length) {
    body.textContent = '';
    empty.hidden = false;
    empty.textContent = !meta
      ? 'data/whale_trades.json not published yet — the scheduled job writes it.'
      : 'No trades in the feed yet.';
    return;
  }

  if (meta?.newest_ts) {
    $('#trades-meta').textContent =
      `${state.feed.length} fills from ${meta.whales} screened whales · newest ${ago(meta.newest_ts)}`;
  }

  const wantV = $('#t-verdict').value;
  const min = Number($('#t-min').value) || 0;
  const onlyDisc = $('#t-disc').checked;

  const noCrypto = $('#t-nocrypto').checked;
  const rows = state.feed.filter((t) => {
    if (wantV && t.verdict !== wantV) return false;
    if ((t.usd || 0) < min) return false;
    if (onlyDisc && !t.discovered) return false;
    // Even screened whales fire off $2 crypto up/down fills. At min=0 those
    // bury the $50k sports positions that are the reason to watch them.
    if (noCrypto && /Up or Down|updown-\d+m/i.test(`${t.title} ${t.slug}`)) return false;
    return true;
  });

  body.textContent = '';
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = 'No fills match these filters.';
  $('#trades-count').textContent = `${rows.length} of ${state.feed.length} fills`;

  rows.slice(0, 400).forEach((t) => {
    const tr = el('tr');
    const when = el('td', 'time', ago(t.ts));
    when.title = new Date(t.ts * 1000).toLocaleString();
    tr.appendChild(when);

    const who = el('td', 'trader');
    const nm = el('b', null, t.name || short(t.wallet));
    const card = state.byWallet.get((t.wallet || '').toLowerCase());
    if (card) {
      nm.style.cursor = 'pointer';
      nm.addEventListener('click', () => openDrawer(card));
    }
    who.appendChild(nm);
    if (t.discovered) who.appendChild(el('span', 'badge-disc', 'OFF-BOARD'));
    tr.appendChild(who);

    const vd = el('td');
    vd.appendChild(el('span', `v v-${t.verdict === 'NOT COPYABLE' ? 'NOT' : t.verdict}`,
      t.verdict));
    tr.appendChild(vd);

    tr.appendChild(el('td', `side-${t.side}`, t.side || '—'));
    tr.appendChild(el('td', 'num', money(t.usd)));
    tr.appendChild(el('td', 'num', t.price != null ? Number(t.price).toFixed(3) : '—'));
    tr.appendChild(el('td', null, t.outcome || '—'));

    const mk = el('td', 'mkt');
    if (t.slug) {
      const a = el('a', null, t.title || t.slug);
      a.href = `https://polymarket.com/event/${t.slug}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = 'inherit';
      mk.appendChild(a);
    } else {
      mk.textContent = t.title || '—';
    }
    mk.title = t.title || '';
    tr.appendChild(mk);

    body.appendChild(tr);
  });
}

/* ───────────────────────────── detail drawer ────────────────────────── */

function openDrawer(c) {
  const b = $('#drawer-body');
  b.textContent = '';

  b.appendChild(el('h2', 'dh', c.name || short(c.wallet)));
  b.appendChild(el('p', 'dsub', c.wallet));

  const chip = el('span', `v v-${c.verdict === 'NOT COPYABLE' ? 'NOT' : c.verdict}`, c.verdict);
  b.appendChild(chip);

  const grid = el('div', 'grid');
  const cell = (k, v, cls) => {
    const d = el('div', 'cell');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', `val ${cls || ''}`, v));
    grid.appendChild(d);
  };
  cell('Total PnL', money(c.position_pnl), signClass(c.position_pnl));
  cell('Max drawdown', money(c.max_dd_usd), 'neg');
  cell('Net / DD', c.net_dd == null ? '—' : num(c.net_dd));
  cell('Realized (trading)', money(c.realized_market_pnl), signClass(c.realized_market_pnl));
  cell('Unrealized marks', money(c.unrealized_pnl), signClass(c.unrealized_pnl));
  cell('Program income', money(c.program_income), 'mut');
  cell('Biggest single win', money(c.biggest_win));
  cell('Concentration', pct(c.concentration));
  cell('Volume traded', money(c.volume_usdc));
  cell('Edge per $', c.edge_per_dollar == null ? '—' : pct(c.edge_per_dollar, 2));
  cell('Fees paid', money(c.fees_paid), 'neg');
  cell('Fills', c.trade_count?.toLocaleString() ?? '—');
  cell('Months +', `${c.pct_positive_months?.toFixed(0) ?? '—'}%`);
  cell('Curve days', String(c.curve_days ?? '—'));
  cell('Curve moves', String(c.curve_moves ?? '—'));
  cell('Idle days', c.days_idle == null ? '—' : String(c.days_idle));
  b.appendChild(grid);

  if (c.flags?.length) {
    b.appendChild(el('div', 'sec', 'Why this is not a copy candidate'));
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

  const link = el('a', 'more', 'View profile on Polymarket ↗');
  link.href = `https://polymarket.com/profile/${c.wallet}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'inline-block';
  link.style.marginTop = '22px';
  b.appendChild(link);

  $('#drawer').hidden = false;
}

/* ───────────────────────────── live tape ────────────────────────────── */

// 5-minute crypto up/down markets generate the majority of fills at trivial
// size. They drown everything else out, so they're filtered by default.
const isChurn = (t) =>
  /updown-\d+m|-5m-\d+/i.test(t.slug || t.eventSlug || '') ||
  /\bUp or Down\b/i.test(t.title || '');

function passesTapeFilters(t) {
  const notional = (Number(t.size) || 0) * (Number(t.price) || 0);
  if (notional < (Number($('#f-min').value) || 0)) return false;
  if ($('#f-crypto').checked && isChurn(t)) return false;
  const card = state.byWallet.get((t.proxyWallet || '').toLowerCase());
  if ($('#f-tracked').checked && !card) return false;
  if ($('#f-best').checked && !(card && (card.verdict === 'CANDIDATE'
      || card.verdict === 'WATCH'))) return false;
  return true;
}

function addTrade(t) {
  state.stamps.push(Date.now());
  state.seen = (state.seen || 0) + 1;
  if (state.paused) return;
  if (!passesTapeFilters(t)) { state.filtered = (state.filtered || 0) + 1; return; }

  const wallet = (t.proxyWallet || '').toLowerCase();
  const card = state.byWallet.get(wallet);
  const notional = (Number(t.size) || 0) * (Number(t.price) || 0);

  const tr = el('tr', `new${card ? ' tracked' : ''}`);
  const ts = t.timestamp ? new Date(t.timestamp * 1000) : new Date();
  tr.appendChild(el('td', 'time', ts.toLocaleTimeString()));

  const who = el('td', 'trader');
  const nm = el('b', null, t.name || t.pseudonym || short(t.proxyWallet));
  nm.title = t.proxyWallet || '';
  who.appendChild(nm);
  if (card) {
    const chip = el('span', `v v-${card.verdict === 'NOT COPYABLE' ? 'NOT' : card.verdict}`,
      card.verdict);
    chip.style.marginLeft = '7px';
    who.appendChild(chip);
    nm.style.cursor = 'pointer';
    nm.addEventListener('click', () => openDrawer(card));
  }
  tr.appendChild(who);

  tr.appendChild(el('td', `side-${t.side}`, t.side || '—'));
  tr.appendChild(el('td', 'num', money(notional)));
  tr.appendChild(el('td', 'num', t.price != null ? Number(t.price).toFixed(3) : '—'));
  tr.appendChild(el('td', null, t.outcome || '—'));
  // ~6% of messages arrive with title/slug/conditionId blank together
  tr.appendChild(el('td', 'mkt', t.title || '—'));

  const body = $('#tape-body');
  body.prepend(tr);
  $('#tape-empty').hidden = true;
  while (body.children.length > MAX_TAPE_ROWS) body.lastChild.remove();

  if (card && $('#f-alert').checked) notify(t, card, notional);
}

function notify(t, card, notional) {
  if (Notification?.permission !== 'granted') return;
  const key = t.transactionHash || `${t.proxyWallet}${t.timestamp}`;
  if (state.notified.has(key)) return;
  state.notified.add(key);
  if (state.notified.size > 500) state.notified.clear();
  new Notification(`${card.name || short(card.wallet)} · ${t.side} ${money(notional)}`, {
    body: `${t.outcome || ''} @ ${Number(t.price).toFixed(3)} — ${t.title || 'unknown market'}`,
    tag: key,
  });
}

/* ───────────────────────────── websocket ────────────────────────────── */

let ws = null, backoff = 1000, pinger = null;

function setStatus(cls, text) {
  $('#ws-pill').className = `pill ${cls}`;
  $('#ws-text').textContent = text;
}

const WS_MAX_FAILS = 6;   // after this, stop dialling a number that never answers

function connect() {
  if ((state.wsFails || 0) < 3) setStatus('pill-off', 'connecting…');
  try { ws = new WebSocket(WS_URL); } catch { return retry(); }

  ws.onopen = () => {
    backoff = 1000;
    setStatus('pill-on', 'live');
    // No filters = the global firehose across every market.
    ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'activity', type: 'trades' }],
    }));
    clearInterval(pinger);
    pinger = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('PING');
    }, 5000);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = m?.payload ?? m;
      if (p && p.proxyWallet && p.side) addTrade(p);
    }
  };

  ws.onerror = () => setStatus('pill-err', 'error');
  ws.onclose = () => { clearInterval(pinger); retry(); };
}

function retry() {
  state.wsFails = (state.wsFails || 0) + 1;
  // Three straight failures is not a blip. The overwhelmingly likely cause is
  // that this browser's DNS cannot resolve polymarket.com -- several Indian
  // ISPs now sinkhole the whole zone. Say so, and point at the tab that works,
  // instead of spinning on "connecting..." forever.
  if (state.wsFails >= 3) {
    setStatus('pill-err', 'direct feed blocked');
    const note = $('#tape-empty');
    if (note) {
      note.hidden = false;
      note.textContent =
        'Cannot reach wss://ws-live-data.polymarket.com from this browser. '
        + 'This is usually DNS: some networks resolve every polymarket.com '
        + 'hostname to one unreachable address. The "Whale trades" tab is '
        + 'collected server-side and works regardless.';
    }
  }
  if (state.wsFails < 3) {
    setStatus('pill-err', `reconnecting in ${Math.round(backoff / 1000)}s`);
  }
  if (state.wsFails >= WS_MAX_FAILS) {
    // Give up rather than retry indefinitely. If DNS for the zone is
    // sinkholed it will not recover on a backoff timer, and each attempt is
    // another console error for no benefit.
    setStatus('pill-err', 'direct feed unavailable');
    return;
  }
  setTimeout(connect, backoff);
  // There is no resume cursor on this socket — a reconnect is a fresh start and
  // trades during the gap are simply lost. The tape is a monitor, not a ledger.
  backoff = Math.min(backoff * 2, 30_000);
}

setInterval(() => {
  const cut = Date.now() - RATE_WINDOW_MS;
  state.stamps = state.stamps.filter((t) => t > cut);
  $('#rate').textContent = state.stamps.length
    ? `${(state.stamps.length / (RATE_WINDOW_MS / 1000)).toFixed(0)} fills/s`
    : '—';
}, 1000);

/* ───────────────────────────── wiring ───────────────────────────────── */

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['board', 'trades', 'tape', 'method'].forEach((n) => {
      $(`#panel-${n}`).hidden = n !== t.dataset.tab;
    });
  });
});

['#sort', '#f-verdict', '#f-rankable', '#f-disc'].forEach((s) =>
  $(s).addEventListener('change', renderBoard));

['#t-verdict', '#t-min', '#t-disc', '#t-nocrypto'].forEach((s) =>
  $(s).addEventListener('input', () => renderTrades()));

$('#pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('#pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('#pause').classList.toggle('on', state.paused);
});

$('#f-alert').addEventListener('change', (e) => {
  if (e.target.checked && Notification?.permission === 'default') {
    Notification.requestPermission();
  }
});

$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; });
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') $('#drawer').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#drawer').hidden = true;
});

setInterval(() => {
  const shown = $('#tape-body').children.length;
  $('#tape-count').textContent =
    `${shown} shown · ${state.filtered || 0} filtered out of ${state.seen || 0}`;
  // Say WHY the tape is empty. "Waiting for fills" is a lie when fills are
  // arriving at 25/sec and the filter is what's hiding them.
  const empty = $('#tape-empty');
  if (shown === 0) {
    empty.hidden = false;
    empty.textContent = (state.seen || 0) === 0
      ? 'Waiting for fills…'
      : `No fills passed your filters yet — ${state.filtered} of ${state.seen} hidden. `
        + `Lower "Min size $" or untick the crypto filter.`;
  }
}, 500);

loadData();
connect();
