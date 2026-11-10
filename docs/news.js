/* News — the macro-news board, its biggest wallets, and a $1,000 paper copy of them.
 *
 * pipeline/pm/news.py writes data/news/news.json (about every 15 minutes, in the paper-funds job):
 *  - every open Polymarket event that settles on one scheduled release (a central-bank meeting,
 *    a US data print), with the crowd's odds and the instruments that release moves;
 *  - the 10 wallets with the most money in each, with their average entry price and the price now;
 *  - a $1,000 account that copies those wallets from its opening, forward only, at the prices of
 *    the real fills that came after each whale's (never the whale's own price).
 */

const IST_S = 19_800;
const istClock = (ts) => new Date((ts + IST_S) * 1000).toISOString().slice(11, 16);
const POLL_MS = 60_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const usd = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut');
const cents = (p) => (p == null ? '—' : `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}¢`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.995 || v < 0.01 ? 1 : 0)}%`);

export function istWhen(ts) {
  const d = new Date((ts + IST_S) * 1000);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}, ${istClock(ts)} IST`;
}

/** "in 3 h 20 min" / "in 2 days" / "12 min ago" for a release time. */
export function countdown(ts, now) {
  const s = ts - now;
  const a = Math.abs(s);
  const txt = a < 3600 ? `${Math.max(1, Math.round(a / 60))} min`
    : a < 86400 ? `${Math.floor(a / 3600)} h ${Math.round((a % 3600) / 60)} min`
      : `${Math.round(a / 86400)} days`;
  return s >= 0 ? `in ${txt}` : `${txt} ago`;
}

export function initNews(ctx) {
  const { el, displayName, snapshotJSON, marketLink, openDrawer, state } = ctx;
  const R = { doc: null, missing: false, polledAt: 0, open: new Set(), showClosed: 20, showEvents: 8 };
  const root = document.querySelector('#news-root');
  const now = () => Math.floor(Date.now() / 1000);

  async function load() {
    try {
      const doc = await snapshotJSON('data/news/news.json');
      if (doc && doc.events) {
        R.doc = doc;
        R.missing = false;
        if (!R.open.size && doc.events.length) R.open.add(doc.events[0].slug);
        render();
      }
    } catch {
      R.missing = true;
      if (!R.doc) render();
    }
  }

  function chip(text, cls = '') {
    return el('span', `nw-chip ${cls}`.trim(), text);
  }

  function whaleName(w) {
    const card = state?.byWallet?.get?.(w.wallet);
    const a = el('button', 'linkish nw-wallet', displayName(w.name, w.wallet));
    a.type = 'button';
    a.title = w.wallet;
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      if (card) openDrawer(card);
      else window.open(`https://polymarket.com/profile/${w.wallet}`, '_blank', 'noopener');
    });
    return a;
  }

  function table(head, rows, cls = '') {
    const wrap = el('div', 'fd-tablewrap');
    const t = el('table', `fd-table ${cls}`.trim());
    const thead = el('thead');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', null, h));
    thead.append(tr);
    const tbody = el('tbody');
    for (const cells of rows) {
      const r = el('tr');
      for (const c of cells) {
        const td = el('td');
        if (c instanceof Node) td.append(c);
        else if (Array.isArray(c)) td.append(...c);
        else td.textContent = c == null ? '—' : String(c);
        r.append(td);
      }
      tbody.append(r);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  /* ── one event: when, what the crowd expects, what it moves, who holds what at what price ── */
  function eventCard(e) {
    const t = now();
    const card = el('article', `nw-event${e.release_ts < t ? ' past' : ''}`);
    const head = el('div', 'nw-head');
    const when = el('div', 'nw-when');
    when.append(el('b', null, istWhen(e.release_ts)), el('span', 'nw-count', countdown(e.release_ts, t)));
    head.append(when, chip(e.kind === 'US data' ? 'US data' : e.group === 'emerging' ? 'Emerging-market bank' : 'Central bank',
      e.group === 'major' ? 'major' : ''));
    card.append(head);
    const title = el('h3', 'nw-title');
    title.append(marketLink(e.title, e.slug));
    card.append(title);

    const fav = el('div', 'nw-fav');
    fav.append(el('span', 'nw-k', 'Crowd expects'), el('b', null, e.favourite),
      el('span', `nw-odds${e.fav_odds >= 0.8 ? ' high' : ''}`, pct(e.fav_odds)));
    card.append(fav);
    const bars = el('div', 'nw-bars');
    for (const o of e.outcomes.slice(0, 5)) {
      const row = el('div', 'nw-bar');
      const fill = el('span', 'nw-fill');
      fill.style.width = `${Math.max(1, o.odds * 100)}%`;
      row.append(el('span', 'nw-lab', o.label), el('span', 'nw-track'), el('span', 'nw-pc', pct(o.odds)));
      row.children[1].append(fill);
      bars.append(row);
    }
    card.append(bars);

    const moves = el('div', 'nw-moves');
    moves.append(el('span', 'nw-k', 'Instruments it moves'));
    for (const i of e.instruments) moves.append(chip(i));
    card.append(moves);
    card.append(el('p', 'nw-note', e.note));

    const det = el('details', 'nw-whales');
    det.open = R.open.has(e.slug);
    det.addEventListener('toggle', () => { if (det.open) R.open.add(e.slug); else R.open.delete(e.slug); });
    const total = e.whales.reduce((s, w) => s + w.usd, 0);
    det.append(el('summary', null, e.whales.length
      ? `The ${e.whales.length} biggest wallets: ${ctx.money(total)} in this event, and the prices they paid`
      : 'No wallet holds this yet'));
    if (e.whales.length) {
      det.append(table(['Wallet', 'Money in', 'Main bet', 'Their avg price', 'Price now', 'Their P&L'],
        e.whales.map((w) => {
          const p = w.positions[0] || {};
          const bet = el('span');
          bet.append(el('b', null, w.side));
          if (w.side_share < 0.9 && w.positions.length > 1) {
            bet.append(el('span', 'tiny nw-also', ` (${Math.round(w.side_share * 100)}% of it; also `
              + w.positions.slice(1, 3).map((x) => `${x.label} @ ${cents(x.avg_price)}`).join(', ') + ')'));
          }
          const pnl = el('span', tone(w.pnl), signed(w.pnl));
          return [whaleName(w), ctx.money(w.usd), bet, cents(p.avg_price), cents(p.price), pnl];
        }), 'nw-wt'));
      det.append(el('p', 'tiny', 'Money in = shares held × price now, summed over every outcome of this event. '
        + 'Avg price is what they paid on average for their main bet (Polymarket\'s own figure). '
        + '"No on X" means they bet that X will not be the result. P&L includes what they already took out.'));
    }
    card.append(det);
    return card;
  }

  /* ── the $1,000 copy account ── */
  function equityChart(f) {
    const pts = f.points || [];
    if (pts.length < 3) return el('p', 'tiny', 'The line starts after a few updates.');
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    let lo = Math.min(f.start, ...pts.map((p) => p[1])), hi = Math.max(f.start, ...pts.map((p) => p[1]));
    const pad = Math.max((hi - lo) * 0.12, 2);
    lo -= pad; hi += pad;
    const W = 600, H = 120;
    const X = (x) => (t1 > t0 ? ((x - t0) / (t1 - t0)) * W : W);
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Copy account equity since it opened');
    const base = document.createElementNS(ns, 'line');
    for (const [k, v] of Object.entries({ x1: 0, x2: W, y1: Y(f.start), y2: Y(f.start), stroke: '#5a5852',
      'stroke-dasharray': '4 4', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' })) base.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    for (const [k, v] of Object.entries({ d: pts.map(([x, v], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(v).toFixed(1)}`).join(''),
      fill: 'none', stroke: '#e97132', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' })) path.setAttribute(k, v);
    svg.append(base, path);
    const wrap = el('div', 'nw-chart');
    wrap.append(svg);
    const axis = el('div', 'fd-axis');
    axis.append(el('span', null, istWhen(t0)), el('span', null, istWhen(t1)));
    wrap.append(axis);
    return wrap;
  }

  function fundSection(F) {
    const f = F.fund;
    const sec = el('section', 'nw-fund');
    sec.append(el('h2', 'nw-h2', 'If you had copied these wallets with $1,000'));
    sec.append(el('p', 'nw-lead', `Paper only, forward from ${istWhen(f.started)}: no back-test, nothing traded. `
      + `When one of an event's 10 biggest wallets puts $${F.rules.signal_usd} or more into one outcome in an `
      + `India-time day, the account buys $${F.rules.stake} of the same outcome — not at the whale's price, `
      + 'but from the real fills that came after theirs, as a copier would.'));
    const tiles = el('div', 'nw-tiles');
    const tile = (k, v, cls = '', sub = '') => {
      const d = el('div', 'nw-tile');
      d.append(el('span', 'nw-k', k), el('b', cls, v));
      if (sub) d.append(el('span', 'tiny', sub));
      tiles.append(d);
    };
    tile('Worth now', usd(f.equity), '', `started with ${usd(f.start)}`);
    tile('Profit / loss', signed(f.pnl), tone(f.pnl), `${signed(f.realized)} closed · ${signed(f.unrealized)} open`);
    tile('Cash', usd(f.cash), '', `${f.open_n} open bet${f.open_n === 1 ? '' : 's'}`);
    tile('Won / closed', f.closed_n ? `${f.won} / ${f.closed_n}` : '—', '',
      f.baseline != null ? `no-skill baseline ${pct(f.baseline)} (the prices paid)` : 'none settled yet');
    tile('Paid above the whale', f.gap_cents == null ? '—' : `${f.gap_cents >= 0 ? '+' : ''}${f.gap_cents.toFixed(1)}¢`,
      f.gap_cents > 0 ? 'neg' : '', 'per share, on average');
    tile('Fees paid', usd(f.fees), '', `worst drop ${usd(f.max_dd)}`);
    sec.append(tiles);
    const c = f.counts || {};
    sec.append(el('p', 'fd-facts', `${c.signals || 0} signals so far: ${c.copied || 0} copied, `
      + `${c.missed_liquidity || 0} missed because less than $${F.rules.stake} traded in the 5 minutes after the whale, `
      + `${c.missed_cash || 0} missed for cash, ${c.held || 0} skipped (already held). `
      + `${c.partial_exits || 0} exits found too few buyers and kept part of the bet.`));
    sec.append(equityChart(f));

    sec.append(el('h3', 'fd-group', 'Open bets'));
    if (!f.open.length) sec.append(el('p', 'tiny', 'None open.'));
    else {
      sec.append(table(['Copied', 'Bet', 'Whale', 'Whale paid', 'We paid', 'Filled from', 'Cost', 'Worth now', 'P&L'],
        f.open.map((p) => {
          const bet = el('span');
          bet.append(el('b', null, p.label), el('br'), marketLink(p.title, p.slug));
          return [istWhen(p.ts), bet, whaleName({ wallet: p.whale, name: p.whale_name }), cents(p.whale_price),
            cents(p.price), `${p.fills} fill${p.fills === 1 ? '' : 's'}, +${p.delay_s}s`, usd(p.cost), usd(p.value),
            el('span', tone(p.pnl_now), signed(p.pnl_now))];
        }), 'nw-ft'));
    }
    sec.append(el('h3', 'fd-group', 'Closed bets'));
    if (!f.closed.length) sec.append(el('p', 'tiny', 'None closed yet.'));
    else {
      const rows = f.closed.slice(0, R.showClosed);
      sec.append(table(['Closed', 'Bet', 'Whale', 'Whale paid', 'We paid', 'How', 'Cost', 'P&L'],
        rows.map((p) => {
          const bet = el('span');
          bet.append(el('b', null, p.label), el('br'), marketLink(p.title, p.slug));
          const how = p.how === 'settled' ? (p.payout ? 'Won, paid $1' : 'Lost, paid $0')
            : 'Sold with the whale';
          return [istWhen(p.close_ts), bet, whaleName({ wallet: p.whale, name: p.whale_name }),
            cents(p.whale_price), cents(p.price), how, usd(p.cost), el('span', tone(p.pnl), signed(p.pnl))];
        }), 'nw-ft'));
      if (f.closed.length > R.showClosed) {
        const more = el('button', 'btn small', `Show ${Math.min(30, f.closed.length - R.showClosed)} more`);
        more.type = 'button';
        more.addEventListener('click', () => { R.showClosed += 30; render(); });
        sec.append(more);
      }
    }
    const how = el('details', 'about');
    how.append(el('summary', null, 'How the copy is priced, and what it cannot see'));
    const body = el('div', 'about-body');
    for (const html of [
      '<b>The price.</b> Polymarket shows every fill but not the order books of the past. So the copy buys from '
        + 'the takers who bought the same outcome after the whale, in time order, starting in the same second, '
        + 'until $' + F.rules.stake + ' is spent. Their average price is ours, plus the market\'s taker fee. '
        + 'If less than $' + F.rules.stake + ' traded in the 5 minutes after, the signal is missed: a copy can only '
        + 'be as big as what really traded.',
      '<b>The exit.</b> When the whale we copied sells part of what it was seen buying, the copy sells the same '
        + 'fraction to the takers who sold after it (the bid side), the same way. Otherwise it holds and is paid '
        + '$1 or $0 a share when the result is out. An open bet is valued at what it would sell for right now.',
      '<b>Who.</b> The 10 biggest wallets of each event as listed by the previous update, so a wallet is copied '
        + 'only after it was already seen at the top. One bet per outcome; the same $' + F.rules.stake + ' every time.',
      '<b>What it cannot see.</b> Our order would also have moved the price for whoever came after, so in thin '
        + 'markets the real cost is, if anything, a little higher. A fill in the same second may in truth have come '
        + 'just before the whale\'s. A whale leaving by merging both sides is not seen as a sale.',
    ]) { const p = el('p'); p.innerHTML = html; body.append(p); }
    how.append(body);
    sec.append(how);
    return sec;
  }

  function render() {
    if (!root) return;
    root.replaceChildren();
    const F = R.doc;
    if (!F) {
      root.append(el('p', 'fd-status', R.missing
        ? 'The news board has not been built yet. It appears after the next pipeline update.'
        : 'Loading the news board…'));
      return;
    }
    const intro = el('details', 'about');
    intro.append(el('summary', null, 'Scheduled news that Polymarket prices — what the crowd expects, what it moves, '
      + 'and what the biggest wallets hold'));
    const ib = el('div', 'about-body');
    for (const html of [
      'Every open Polymarket market that settles on one scheduled release: a central-bank rate decision or a US '
        + 'data print (CPI, jobs, PCE, PPI, GDP, ISM, claims, JOLTS), up to 45 days ahead. Times are the published '
        + 'release time in India time; the Bank of Japan has no fixed time, so 11:00 Tokyo is shown.',
      '<b>Reading the odds.</b> In our back-test a major central bank\'s favourite priced at 80% or more two minutes '
        + 'before was right 81 of 81 times — and then RBNZ broke it live on 28 Oct (98.6% for a hike; it held). US data '
        + 'is rarely priced that high and the favourite is often wrong. A known decision tells you what will be '
        + 'announced, not which way the instrument moves: that comes from the statement and the press conference.',
      '<b>The wallets</b> are the 10 holding the most money in the event right now. Their prices are what they paid. '
        + 'In the back-test, following the biggest money added nothing beyond the crowd\'s own price.',
    ]) { const p = el('p'); p.innerHTML = html; ib.append(p); }
    intro.append(ib);
    root.append(intro);

    root.append(el('h2', 'nw-h2', 'Upcoming news'));
    const list = el('div', 'nw-list');
    const t = now();
    const events = [...F.events].sort((a, b) => (a.release_ts < t) - (b.release_ts < t) || a.release_ts - b.release_ts);
    if (!events.length) list.append(el('p', 'tiny', 'No scheduled news market is open right now.'));
    for (const e of events.slice(0, R.showEvents)) list.append(eventCard(e));
    root.append(list);
    if (events.length > R.showEvents) {
      const more = el('button', 'btn small nw-more', `Show all ${events.length} news events`);
      more.type = 'button';
      more.addEventListener('click', () => { R.showEvents = events.length; render(); });
      root.append(more);
    }
    root.append(fundSection(F));
  }

  return {
    render,
    tick() {
      if (Date.now() - R.polledAt < POLL_MS && R.doc) return;
      R.polledAt = Date.now();
      load();
    },
    generatedAt: () => R.doc?.generated_at,
  };
}
