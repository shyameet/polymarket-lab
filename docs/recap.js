/* Daily recap — what the worth-following whales did each India-time day.
 *
 * The pipeline (pipeline/pm/daily.py) writes one file per IST day to
 * data/daily/, and rewrites today and the two days before on every run,
 * because outcomes keep arriving after a day ends: markets settle, whales sell.
 * This view reads those files and adds the one thing the pipeline cannot — the
 * entries made SINCE its last run, pulled live while you look at today.
 *
 * Everything shown by default is a count you can check ("won 119 of 152"), and
 * beside every win rate sits the no-skill baseline: the price paid. A buyer with
 * no edge who pays 80c still wins about 80% of the time, so a high win rate on
 * favourites is not skill. Only the gap between the two bars is.
 *
 * The $100-copy number is a ceiling: it assumes the whale's own price and exit.
 * Taker fees are charged; lateness is not, and a real copy is always later.
 */

export const IST_MS = 19_800_000;          // +05:30, no daylight saving
export const istDay = (ts) => new Date(ts * 1000 + IST_MS).toISOString().slice(0, 10);
export const istClock = (ts) => new Date(ts * 1000 + IST_MS).toISOString().slice(11, 16);
const NEAR = 0.02;                          // "still near their price": within 2c
const TOPUP_EVERY_MS = 10 * 60_000;       // ~210 relay requests per check, so not more often
const DAY_POLL_MS = 30_000;

/** 'YYYY-MM' -> Monday-first calendar cells: a date string, or null for padding. */
export function monthCells(ym) {
  const [y, m] = ym.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Same numbers as the pipeline's summarise(), for any filtered set of rows. */
export function summarise(rows) {
  const closed = rows.filter((r) => r.status === 'won' || r.status === 'lost');
  const open = rows.filter((r) => r.status === 'open');
  const won = closed.filter((r) => r.status === 'won').length;
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    entries: rows.length, closed: closed.length, won, lost: closed.length - won, open: open.length,
    win_rate: closed.length ? won / closed.length : null,
    baseline: closed.length ? sum(closed, 'baseline') / closed.length : null,
    copy_pnl_closed: sum(closed, 'copy_pnl'), copy_pnl_open: sum(open, 'copy_pnl'),
    entry_usd: sum(rows, 'usd'),
  };
}

/** One wallet's raw /activity rows -> buys and sells after `since`, one per token. */
export function newSince(rows, since, minUsd = 100) {
  const groups = { BUY: new Map(), SELL: new Map() };
  for (const r of rows) {
    const size = Number(r.size) || 0;
    if (r.type !== 'TRADE' || !(r.timestamp > since) || !(size > 0) || !groups[r.side]) continue;
    const g = groups[r.side].get(r.asset) || { asset: r.asset, condition: r.conditionId || '',
      outcome: r.outcome || '', title: r.title || '', slug: r.slug || '',
      ts: r.timestamp, shares: 0, usd: 0, fills: 0 };
    g.shares += size;
    g.usd += Number(r.usdcSize) || size * (Number(r.price) || 0);
    g.fills += 1;
    g.ts = Math.min(g.ts, r.timestamp);
    groups[r.side].set(r.asset, g);
  }
  const done = (m) => [...m.values()].filter((g) => g.usd >= minUsd)
    .map((g) => ({ ...g, price: g.usd / g.shares }));
  return { entries: done(groups.BUY), exits: done(groups.SELL) };
}

/** Relay REST URL. The nonce misses the upstream 5-minute CDN cache (see live.js). */
export function relayURLFor(relay, host, path, params, now = Date.now()) {
  const u = new URL(`${relay.replace(/\/+$/, '')}/api/${host}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('_', String(now));
  return u.href;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return `${WEEKDAY[t.getUTCDay()]} ${t.getUTCDate()} ${MONTH[t.getUTCMonth()]}`;
};
const cents = (p) => (p == null ? '—' : `${Math.round(p * 100)}¢`);
const signed = (money, v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${money(v)}`);
const pctTxt = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function initRecap(ctx) {
  const { state, el, displayName, money, ago, snapshotJSON, relayURL, marketLink,
    copyMarketBtn, openDrawer, CAT_LABEL } = ctx;
  const R = {
    index: null, days: new Map(), selected: '', month: '',
    category: '', status: '', sort: 'new', whale: '', show: 40, allWhales: false, allNew: false,
    topup: null, topupBusy: false, livePrice: new Map(), polledAt: 0,
  };
  const root = document.querySelector('#recap-root');
  const today = () => istDay(Math.floor(Date.now() / 1000));
  const isToday = (d) => d === today();

  async function loadIndex() {
    try {
      const ix = await snapshotJSON('data/daily/index.json');
      if (ix && Array.isArray(ix.days)) {
        R.index = ix;
        if (!ix.days.some((d) => d.date === R.selected)) R.selected = ix.days[0]?.date || '';
        if (!R.month) R.month = R.selected.slice(0, 7);
        render();
      }
    } catch { /* first run not written yet, or mid-deploy; next poll retries */ }
    if (R.selected) await loadDay(R.selected);
  }

  async function loadDay(date) {
    try {
      const doc = await snapshotJSON(`data/daily/${date}.json`);
      if (doc && Array.isArray(doc.entries)) {
        R.days.set(date, doc);
        if (R.topup && R.topup.since !== doc.generated_at) R.topup = null;
        render();
        if (isToday(date)) topup();
      }
    } catch { /* keep what we have */ }
  }

  /* ── live top-up: entries since the pipeline's last run, today only ── */
  async function topup(force = false) {
    const doc = R.days.get(R.selected);
    const relay = relayURL();
    if (!doc || !isToday(R.selected) || R.topupBusy || !relay) return;
    if (!force && R.topup && Date.now() - R.topup.at < TOPUP_EVERY_MS) return;
    R.topupBusy = true;
    render();
    const since = doc.generated_at, until = Math.floor(Date.now() / 1000);
    const whales = state.whales.filter((c) => c.verdict === 'CANDIDATE');
    const found = { entries: [], exits: [] };
    let failed = 0;
    const queue = [...whales];
    const get = async (host, path, params) => {
      const r = await fetch(relayURLFor(relay, host, path, params),
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const rows = await get('data', '/activity',
            { user: c.wallet, limit: 500, type: 'TRADE', start: since + 1, end: until });
          const g = newSince(Array.isArray(rows) ? rows : [], since);
          for (const k of ['entries', 'exits']) {
            for (const x of g[k]) found[k].push({ ...x, wallet: c.wallet, name: c.name });
          }
        } catch { failed += 1; }
      }
    }));
    // Re-price what can still be acted on: the new buys, then the biggest open
    // rows of the saved file. Capped, because each is one request.
    const openRows = doc.entries.filter((r) => r.status === 'open' && r.condition)
      .sort((a, b) => b.usd - a.usd).slice(0, 30);
    const conds = [...new Set([...found.entries.map((e) => e.condition), ...openRows.map((r) => r.condition)])]
      .filter((c) => c && c.length === 66).slice(0, 60);
    const cq = [...conds];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (cq.length) {
        const cid = cq.shift();
        try {
          const m = await get('clob', `/markets/${cid}`, {});
          for (const t of m.tokens || []) {
            R.livePrice.set(String(t.token_id), { price: Number(t.price), at: Date.now(), closed: !!m.closed });
          }
        } catch { /* leave this one at its saved price */ }
      }
    }));
    R.topup = { since, at: Date.now(), ...found, failed, asked: whales.length };
    R.topupBusy = false;
    render();
  }

  /* ── filtering ── */
  const followOnly = () => state.watchOnly && state.watchlist.size > 0;
  function rowsOf(doc) {
    return doc.entries.filter((r) => {
      const w = doc.whales[r.w];
      if (!w) return false;
      if (R.category && r.category !== R.category) return false;
      if (R.whale && w.wallet !== R.whale) return false;
      if (followOnly() && !state.watchlist.has(w.wallet)) return false;
      return true;
    });
  }

  /* ── pieces ── */
  function calendar() {
    const box = el('div', 'rc-cal');
    const months = [...new Set((R.index?.days || []).map((d) => d.date.slice(0, 7)))].sort();
    const head = el('div', 'rc-cal-head');
    const i = months.indexOf(R.month);
    const nav = (label, to, aria) => {
      const b = el('button', 'btn small', label);
      b.type = 'button'; b.setAttribute('aria-label', aria);
      b.disabled = !to;
      b.addEventListener('click', () => { R.month = to; render(); });
      return b;
    };
    const [y, m] = R.month.split('-').map(Number);
    head.append(nav('‹', months[i - 1], 'Previous month'),
      el('b', null, `${MONTH[m - 1]} ${y}`), nav('›', months[i + 1], 'Next month'));
    box.append(head);
    const grid = el('div', 'rc-grid');
    for (const w of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(el('span', 'rc-dow', w));
    const byDate = new Map((R.index?.days || []).map((d) => [d.date, d]));
    for (const d of monthCells(R.month)) {
      if (!d) { grid.append(el('span', 'rc-day pad')); continue; }
      const s = byDate.get(d);
      const cls = !s ? 'none' : !s.closed ? 'flat' : s.copy_pnl_closed > 0 ? 'up' : 'down';
      const b = el('button', `rc-day ${cls}${d === R.selected ? ' sel' : ''}${isToday(d) ? ' today' : ''}`);
      b.type = 'button';
      b.append(el('span', 'rc-dn', String(Number(d.slice(8)))));
      if (s?.closed) b.append(el('span', 'rc-dw', pctTxt(s.win_rate)));
      b.title = s ? `${niceDate(d)}: won ${s.won} of ${s.closed} closed (${pctTxt(s.win_rate)}; `
        + `price baseline ${pctTxt(s.baseline)}), ${signed(money, s.copy_pnl_closed)} copying `
        + `each with $${R.index.stake_usd}. ${s.open} still open.` : `${niceDate(d)}: no recap`;
      if (s) b.addEventListener('click', () => { R.selected = d; R.show = 40; R.whale = ''; render(); loadDay(d); });
      else b.disabled = true;
      grid.append(b);
    }
    box.append(grid);
    const key = el('p', 'rc-key tiny');
    key.append(el('span', 'rc-sw up'), ' copying made money  ', el('span', 'rc-sw down'),
      ' lost money  ', el('span', 'rc-sw flat'), ' nothing closed yet');
    box.append(key);
    return box;
  }

  function bars(s) {
    const box = el('div', 'rc-bars');
    const row = (label, v, cls) => {
      const r = el('div', 'rc-bar');
      r.append(el('span', 'rc-bl', label));
      const track = el('span', 'rc-track');
      const fill = el('span', `rc-fill ${cls}`);
      fill.style.width = `${Math.round((v || 0) * 100)}%`;
      track.append(fill);
      r.append(track, el('span', 'rc-bv', pctTxt(v)));
      return r;
    };
    box.append(row('Whales won', s.win_rate, 'whale'), row('Price baseline', s.baseline, 'coin'));
    // Winning more often than the price implied is only half of it: a whale can
    // win 3 small ones and lose 1 big one. The sentence checks the money too.
    const gap = s.win_rate != null && s.baseline != null ? s.win_rate - s.baseline : null;
    const pts = gap == null ? 0 : Math.round(Math.abs(gap) * 100);
    const paid = s.copy_pnl_closed > 0;
    box.append(el('p', 'tiny rc-gap', gap == null ? 'Nothing has closed yet, so there is nothing to compare.'
      : gap > 0.03 && paid ? `${pts} points better than the prices they paid implied, and copying paid.`
        : gap > 0.03 ? `${pts} points better than their prices implied, but the losses were bigger than the wins: copying lost money.`
          : gap < -0.03 ? `${pts} points WORSE than their prices implied${paid ? ', though a few big wins still made copying pay' : ''}.`
            : `About what their prices implied: no visible edge${paid ? ', though copying came out ahead' : ''}.`));
    return box;
  }

  function headline(doc, rows) {
    const s = summarise(rows);
    const card = el('div', 'rc-head');
    const top = el('div', 'rc-htop');
    top.append(el('b', 'rc-date', niceDate(doc.date)));
    top.append(el('span', `tag ${doc.entries_complete ? 'plain' : 'stack'}`,
      doc.entries_complete ? 'full day' : 'today so far'));
    const scope = [];
    if (R.category) scope.push(CAT_LABEL[R.category] || R.category);
    if (R.whale) scope.push(displayName(doc.whales.find((w) => w.wallet === R.whale)?.name, R.whale));
    if (followOnly()) scope.push('whales I follow');
    if (scope.length) top.append(el('span', 'tag', scope.join(' · ')));
    card.append(top);

    const big = el('div', 'rc-big');
    big.append(el('span', 'rc-frac', `${s.won} / ${s.closed}`), el('span', 'rc-won', 'won'));
    card.append(big);
    card.append(bars(s));

    const copy = el('p', 'rc-copy');
    copy.append('Copying every closed trade with ', el('b', null, `$${doc.stake_usd}`), ': ',
      el('b', s.copy_pnl_closed >= 0 ? 'pos' : 'neg', signed(money, s.copy_pnl_closed)),
      ` after fees, over ${s.closed} copies.`);
    card.append(copy);
    card.append(el('p', 'tiny rc-sub', `${s.open} still open (${signed(money, s.copy_pnl_open)} at the `
      + `last price, not counted) · ${s.entries} entries of $${doc.min_entry_usd}+ from `
      + `${new Set(rows.map((r) => r.w)).size} whales · outcomes as of ${istClock(doc.generated_at)} IST `
      + `(${ago(doc.generated_at)} ago)`));
    return card;
  }

  function chips(doc) {
    const wrap = el('div', 'controls');
    const mk = (id, opts, cur, set) => {
      const bar = el('div', 'chips scroller');
      bar.id = id;
      for (const [v, label] of opts) {
        const b = el('button', `chip${v === cur ? ' active' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => { set(v); R.show = 40; render(); });
        bar.append(b);
      }
      return bar;
    };
    const cats = Object.entries(doc.by_category || {}).sort((a, b) => b[1].entries - a[1].entries)
      .map(([k, v]) => [k, `${CAT_LABEL[k] || 'Other'} ${v.entries}`]);
    wrap.append(mk('rc-cats', [['', 'All topics'], ...cats], R.category, (v) => { R.category = v; }));
    wrap.append(mk('rc-status', [['', 'All'], ['won', 'Won'], ['lost', 'Lost'], ['open', 'Open']],
      R.status, (v) => { R.status = v; }));
    wrap.append(mk('rc-sort', [['new', 'Newest'], ['big', 'Biggest'], ['best', 'Best copy'], ['worst', 'Worst copy']],
      R.sort, (v) => { R.sort = v; }));
    return wrap;
  }

  // The "what did I miss that I can still take" list: open, not yet decided,
  // and priced within 2c of what the whale paid.
  function stillNear(doc, rows) {
    if (!isToday(doc.date)) return null;
    const near = [];
    for (const r of rows) {
      if (r.status !== 'open' || !r.asset) continue;
      const live = R.livePrice.get(r.asset);
      const now = live ? live.price : r.value;
      if (now != null && now > 0.02 && now < 0.98 && now <= r.entry + NEAR) near.push({ r, now, live: !!live });
    }
    for (const e of R.topup?.entries || []) {
      if (followOnly() && !state.watchlist.has(e.wallet)) continue;
      const live = R.livePrice.get(e.asset);
      if (live && !live.closed && live.price > 0.02 && live.price < 0.98 && live.price <= e.price + NEAR) {
        near.push({ r: { ...e, entry: e.price, fresh: true }, now: live.price, live: true });
      }
    }
    const box = el('div', 'rc-near');
    box.append(el('h3', null, 'Still near their price'));
    if (!near.length) {
      box.append(el('p', 'tiny', 'Nothing open is within 2¢ of what the whale paid right now.'));
      return box;
    }
    // One row per market + outcome. Several proven whales on the same side is a
    // stronger read than one, and five near-identical rows would bury the rest.
    const groups = new Map();
    for (const n of near) {
      const k = `${n.r.title}|${n.r.outcome}`;
      const g = groups.get(k) || { r: n.r, now: n.now, live: false, fresh: false, whales: new Map(), usd: 0, shares: 0 };
      const w = n.r.fresh ? { wallet: n.r.wallet, name: n.r.name } : doc.whales[n.r.w];
      if (w) g.whales.set(w.wallet, w);
      g.usd += n.r.usd;
      g.shares += n.r.usd / n.r.entry;
      g.live = g.live || n.live;
      g.fresh = g.fresh || !!n.r.fresh;
      if (n.live) g.now = n.now;
      groups.set(k, g);
    }
    const list = el('ul', 'tape');
    for (const g of [...groups.values()].sort((a, b) => b.whales.size - a.whales.size || b.usd - a.usd).slice(0, 12)) {
      const li = el('li', 'row rc-row');
      const who = el('div', 'who');
      const ws = [...g.whales.values()];
      who.append(whaleName(ws[0]));
      if (ws.length > 1) {
        const more = el('span', 'tag stack', `+${ws.length - 1} more`);
        more.title = ws.slice(1).map((w) => displayName(w.name, w.wallet)).join(', ');
        who.append(more);
      }
      if (g.fresh) who.append(el('span', 'tag stack', 'new'));
      li.append(who, el('div', 'headline-num', money(g.usd)));
      const says = el('div', 'says');
      says.append(el('span', 'when', istClock(g.r.ts)),
        ` ${ws.length > 1 ? `${ws.length} whales` : 'bought'} "${g.r.outcome || '?'}" at ${cents(g.usd / g.shares)}`
        + `${ws.length > 1 ? ' average' : ''} · now `, el('b', null, cents(g.now)), g.live ? '' : ' (saved price)');
      li.append(says, marketLine(g.r));
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function whaleName(w) {
    const nm = el('span', 'nm', displayName(w?.name, w?.wallet));
    const card = state.byWallet.get((w?.wallet || '').toLowerCase());
    if (card) nm.addEventListener('click', () => openDrawer(card));
    return nm;
  }

  function marketLine(r) {
    const mk = el('div', 'mkt');
    mk.append(marketLink(r.title, r.slug));
    if (r.title) mk.append(copyMarketBtn(r.title));
    return mk;
  }

  function outcomeText(r) {
    if (r.state === 'combo') return 'a parlay — result not tracked';
    const sold = r.exit != null ? `sold${r.sold_frac < 0.98 ? ` ${Math.round(r.sold_frac * 100)}%` : ''} at ${cents(r.exit)}` : '';
    if (r.state === 'sold') return sold;
    const rest = r.state === 'settled' ? (r.value === 1 ? 'won — paid $1' : 'lost — worth 0')
      : r.state === 'decided' ? (r.value === 1 ? 'decided: won' : 'decided: lost')
        : r.state === 'open' ? `now ${cents(r.value)}` : 'price unavailable';
    return sold ? `${sold}, rest ${rest}` : rest;
  }

  function tradeRow(doc, r) {
    const li = el('li', 'row rc-row');
    const who = el('div', 'who');
    who.append(whaleName(doc.whales[r.w]));
    who.append(el('span', `rc-pill ${r.status}`, r.state === 'combo' ? 'PARLAY' : r.status.toUpperCase()));
    if (r.category && CAT_LABEL[r.category]) who.append(el('span', 'tag', CAT_LABEL[r.category]));
    li.append(who);
    const right = el('div');
    right.append(el('div', `headline-num ${r.copy_pnl == null ? 'mut' : r.copy_pnl >= 0 ? 'pos' : 'neg'}`,
      r.copy_pnl == null ? '—' : signed(money, r.copy_pnl)));
    right.append(el('div', 'headline-sub', r.status === 'open' ? 'per $100, if sold now' : 'per $100 copied'));
    li.append(right);
    const says = el('div', 'says');
    says.append(el('span', 'when', istClock(r.ts)),
      ` bought "${r.outcome || '?'}" at ${cents(r.entry)} · ${money(r.usd)}${r.fills > 1 ? ` in ${r.fills} fills` : ''} → `,
      el('b', null, outcomeText(r)));
    li.append(says, marketLine(r));
    return li;
  }

  function tradeList(doc, rows) {
    const box = el('div');
    let list = R.status ? rows.filter((r) => r.status === R.status) : rows.slice();
    const by = { new: (a, b) => b.ts - a.ts, big: (a, b) => b.usd - a.usd,
      best: (a, b) => (b.copy_pnl ?? -1e9) - (a.copy_pnl ?? -1e9),
      worst: (a, b) => (a.copy_pnl ?? 1e9) - (b.copy_pnl ?? 1e9) }[R.sort];
    list.sort(by);
    box.append(el('h3', null, `Trades (${list.length})`));
    if (!list.length) { box.append(el('p', 'empty', 'No trades match these filters.')); return box; }
    const ul = el('ul', 'tape');
    for (const r of list.slice(0, R.show)) ul.append(tradeRow(doc, r));
    box.append(ul);
    if (list.length > R.show) {
      const more = el('button', 'btn', `Show ${Math.min(40, list.length - R.show)} more`);
      more.type = 'button';
      more.addEventListener('click', () => { R.show += 40; render(); });
      box.append(more);
    }
    return box;
  }

  function newPanel(doc) {
    if (!isToday(doc.date)) return null;
    const box = el('div', 'rc-new');
    const head = el('div', 'rc-htop');
    head.append(el('h3', null, 'New since the last update'));
    const btn = el('button', 'btn small', R.topupBusy ? 'Checking…' : 'Check now');
    btn.type = 'button'; btn.disabled = R.topupBusy;
    btn.addEventListener('click', () => topup(true));
    head.append(btn);
    box.append(head);
    const t = R.topup;
    if (!relayURL()) { box.append(el('p', 'tiny', 'Live check needs the relay (see Data source).')); return box; }
    if (!t) { box.append(el('p', 'tiny', R.topupBusy ? 'Asking each whale for trades since '
      + `${istClock(doc.generated_at)} IST…` : 'Not checked yet.')); return box; }
    const entries = t.entries.filter((e) => !followOnly() || state.watchlist.has(e.wallet))
      .sort((a, b) => b.ts - a.ts);
    const exits = t.exits.filter((e) => !followOnly() || state.watchlist.has(e.wallet));
    box.append(el('p', 'tiny', `Since ${istClock(t.since)} IST: ${entries.length} new buys, ${exits.length} sells `
      + `of $100+ · checked ${ago(Math.floor(t.at / 1000))} ago${t.failed ? ` · ${t.failed} whales did not answer` : ''}. `
      + 'These are too new to have a result; the next pipeline run scores them.'));
    const ul = el('ul', 'tape');
    const all = [...entries.map((x) => ({ ...x, side: 'BUY' })), ...exits.map((x) => ({ ...x, side: 'SELL' }))]
      .sort((a, b) => b.ts - a.ts);
    for (const e of all.slice(0, R.allNew ? 60 : 10)) {
      const li = el('li', 'row rc-row');
      const who = el('div', 'who');
      who.append(whaleName(e), el('span', `side ${e.side}`, e.side === 'BUY' ? 'BOUGHT' : 'SOLD'));
      li.append(who, el('div', 'headline-num', money(e.usd)));
      const live = R.livePrice.get(e.asset);
      const says = el('div', 'says');
      says.append(el('span', 'when', istClock(e.ts)), ` "${e.outcome || '?'}" at ${cents(e.price)}`,
        live && e.side === 'BUY' ? ` · now ${cents(live.price)}` : '');
      li.append(says, marketLine(e));
      ul.append(li);
    }
    if (ul.childElementCount) box.append(ul);
    if (all.length > 10) {
      const more = el('button', 'btn small', R.allNew ? 'Show fewer' : `Show all ${Math.min(60, all.length)}`);
      more.type = 'button';
      more.addEventListener('click', () => { R.allNew = !R.allNew; render(); });
      box.append(more);
    }
    return box;
  }

  function whaleTable(doc, rows) {
    const box = el('div');
    const per = new Map();
    for (const r of rows) {
      if (!per.has(r.w)) per.set(r.w, []);
      per.get(r.w).push(r);
    }
    const list = [...per.entries()].map(([w, rs]) => ({ w: doc.whales[w], s: summarise(rs) }))
      .sort((a, b) => b.s.entry_usd - a.s.entry_usd);
    box.append(el('h3', null, `Whales that day (${list.length})`));
    const ul = el('ul', 'tape');
    for (const { w, s } of list.slice(0, R.allWhales ? 150 : 8)) {
      const li = el('li', `row rc-row${R.whale === w.wallet ? ' alert' : ''}`);
      const who = el('div', 'who');
      who.append(whaleName(w));
      const pick = el('button', 'linkish', R.whale === w.wallet ? 'show everyone' : 'only this whale');
      pick.type = 'button';
      pick.addEventListener('click', () => { R.whale = R.whale === w.wallet ? '' : w.wallet; R.show = 40; render(); });
      who.append(pick);
      li.append(who, el('div', `headline-num ${s.copy_pnl_closed >= 0 ? 'pos' : 'neg'}`, signed(money, s.copy_pnl_closed)));
      li.append(el('div', 'says', `won ${s.won} of ${s.closed} closed (${pctTxt(s.win_rate)} vs ${pctTxt(s.baseline)} `
        + `baseline) · ${s.open} open · ${money(s.entry_usd)} bought`));
      ul.append(li);
    }
    box.append(ul);
    if (list.length > 8) {
      const more = el('button', 'btn small', R.allWhales ? 'Show fewer' : `Show all ${list.length} whales`);
      more.type = 'button';
      more.addEventListener('click', () => { R.allWhales = !R.allWhales; render(); });
      box.append(more);
    }
    return box;
  }

  function olderExits(doc) {
    const rows = (doc.exits_older || []).filter((o) => !followOnly() || state.watchlist.has(o.wallet));
    if (!rows.length) return null;
    const d = el('details', 'about');
    d.append(el('summary', null, `Sells of positions opened before ${niceDate(doc.date)} (${rows.length}) — entry unknown, so no profit shown`));
    const ul = el('ul', 'tape');
    for (const o of rows.slice(0, 60)) {
      const li = el('li', 'row rc-row');
      const who = el('div', 'who');
      who.append(whaleName({ wallet: o.wallet, name: state.byWallet.get(o.wallet.toLowerCase())?.name }),
        el('span', 'side SELL', 'SOLD'));
      li.append(who, el('div', 'headline-num', money(o.usd)));
      const says = el('div', 'says');
      says.append(el('span', 'when', istClock(o.ts)), ` "${o.outcome || '?'}" at ${cents(o.price)}`);
      li.append(says, marketLine(o));
      ul.append(li);
    }
    d.append(ul);
    return d;
  }

  function render() {
    if (!root || state.view !== 'recap') return;
    const y = window.scrollY;
    root.replaceChildren();
    if (!R.index) { root.append(el('p', 'empty', 'Loading the daily recap…')); return; }
    if (!R.index.days.length) {
      root.append(el('p', 'empty', 'No recap written yet — the pipeline writes the first one on its next run.'));
      return;
    }
    root.append(calendar());
    const doc = R.days.get(R.selected);
    if (!doc) { root.append(el('p', 'empty', `Loading ${niceDate(R.selected)}…`)); return; }
    const rows = rowsOf(doc);
    root.append(headline(doc, rows), chips(doc));
    // what can still be acted on first, then the day's record
    for (const part of [stillNear(doc, rows), newPanel(doc), whaleTable(doc, rows), tradeList(doc, rows), olderExits(doc)]) {
      if (part) root.append(part);
    }
    window.scrollTo({ top: y });
  }

  // Called every second by the app while this view is open; does real work at
  // most every 30s (saved files) and every 5 min (live top-up).
  function tick() {
    if (state.view !== 'recap') return;
    const first = !R.polledAt;
    // The first load happens even in a background tab, so the view is ready
    // when it is looked at; after that, nothing polls while hidden.
    if (document.hidden && !first) return;
    if (first || Date.now() - R.polledAt > DAY_POLL_MS) { R.polledAt = Date.now(); loadIndex(); }
    if (isToday(R.selected) && !document.hidden) topup();
  }

  return { render, tick, loadIndex, state: R,
    generatedAt: () => R.days.get(R.selected)?.generated_at || R.index?.generated_at };
}
