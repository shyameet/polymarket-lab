/* Paper fund — two $1,000 paper accounts that copy the worth-following whales by rule.
 *
 * pipeline/pm/fund.py replays every whale fill since its last run, in time order,
 * the way a bot watching live would have traded it, and writes data/fund/fund.json.
 * This view only reads that file. There is no live top-up here on purpose: a
 * fund's book has to come from one ledger, or the numbers stop adding up.
 *
 * Every copy is filled at the whale's own price in the same second — the best
 * case. Beside it sits the same trade copied a minute late, so the cost of a real
 * delay is on the page instead of hidden.
 */

const IST_S = 19_800;                       // +05:30, no daylight saving
const istDay = (ts) => new Date((ts + IST_S) * 1000).toISOString().slice(0, 10);
const istClock = (ts) => new Date((ts + IST_S) * 1000).toISOString().slice(11, 16);
const POLL_MS = 30_000;
const COLOR_SEL = '#e97132';                // the brand orange: the fund being read
const COLOR_OTHER = '#8a8780';              // the other fund, in neutral grey

/** Unix seconds of India midnight starting the day that contains ts. */
export function istMidnight(ts) {
  return Math.floor((ts + IST_S) / 86_400) * 86_400 - IST_S;
}

/** Equity change since `since`: the last reading minus the last one at or before
 *  `since` (or the first reading, when the fund is younger than that). */
export function changeSince(points, since) {
  if (!points?.length) return null;
  let base = points[0][1];
  for (const [t, v] of points) {
    if (t <= since) base = v;
    else break;
  }
  return points[points.length - 1][1] - base;
}

/** Days (newest first, as the pipeline writes them) grouped into Monday-first weeks. */
export function weeks(days, start) {
  const out = new Map();
  let prevEquity = start;
  for (const d of [...days].reverse()) {
    const t = new Date(`${d.date}T00:00:00Z`);
    const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const w = out.get(monday) || { week: monday, copied: 0, missed: 0, closed: 0, won: 0, realized: 0,
      equity: null, change: null, from: prevEquity };
    w.copied += d.copied || 0;
    w.missed += d.missed || 0;
    w.closed += d.closed || 0;
    w.won += d.won || 0;
    w.realized += d.realized || 0;
    if (d.equity != null) {
      w.equity = d.equity;
      w.change = d.equity - w.from;
      prevEquity = d.equity;
    }
    out.set(monday, w);
  }
  return [...out.values()].reverse();
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return `${WEEKDAY[t.getUTCDay()]} ${t.getUTCDate()} ${MONTH[t.getUTCMonth()]}`;
};
const shortDate = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return `${t.getUTCDate()} ${MONTH[t.getUTCMonth()]}`;
};
const cents = (p) => (p == null ? '—' : `${Math.round(p * 100)}¢`);
const dollars = (v) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${dollars(v)}`);
const signed = (v) => (v == null ? '—' : `${v > 0.004 ? '+' : v < -0.004 ? '-' : ''}$${dollars(v)}`);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const tone = (v) => (v == null || Math.abs(v) < 0.005 ? 'mut' : v > 0 ? 'pos' : 'neg');

export function initFund(ctx) {
  const { state, el, displayName, ago, snapshotJSON, marketLink, copyMarketBtn, openDrawer, CAT_LABEL } = ctx;
  let saved = 'A';
  try { saved = localStorage.getItem('whaleLab.fund') || 'A'; } catch { /* private window: default */ }
  const R = { doc: null, missing: false, sel: saved, closedFilter: '', showOpen: 20, showClosed: 30,
    allDays: false, polledAt: 0 };
  const root = document.querySelector('#fund-root');
  const now = () => Math.floor(Date.now() / 1000);
  const when = (ts) => (istDay(ts) === istDay(now()) ? istClock(ts) : `${shortDate(istDay(ts))} ${istClock(ts)}`);

  async function load() {
    try {
      const doc = await snapshotJSON('data/fund/fund.json');
      if (doc && doc.funds) {
        R.doc = doc;
        R.missing = false;
        if (!doc.funds[R.sel]) R.sel = Object.keys(doc.funds)[0];
        render();
      }
    } catch {
      // not written yet (the pipeline opens the funds on its first run) or mid-deploy
      R.missing = true;
      if (!R.doc) render();
    }
  }

  /* ── pieces ── */
  function whaleName(wallet, name) {
    const nm = el('span', 'nm', displayName(name, wallet));
    const card = state.byWallet.get((wallet || '').toLowerCase());
    if (card) nm.addEventListener('click', () => openDrawer(card));
    return nm;
  }

  function marketLine(r) {
    const mk = el('div', 'mkt');
    mk.append(marketLink(r.title, r.slug));
    if (r.title) mk.append(copyMarketBtn(r.title));
    return mk;
  }

  function statusLine(F) {
    const box = el('p', 'tiny fd-status');
    box.append(`Opened ${niceDate(istDay(F.started))} at ${istClock(F.started)} IST. `,
      `Whale trades replayed up to ${when(F.cursor)} IST (updated ${ago(F.generated_at)} ago).`);
    const lr = F.last_run;
    if (lr) {
      box.append(` Last update read ${lr.fills.toLocaleString('en-US')} whale trades from ${lr.whales} whales: `
        + `${lr.signals} new ${lr.signals === 1 ? 'signal' : 'signals'}`
        + `${lr.failed ? `, ${lr.failed} whales did not answer` : ''}.`);
    }
    return box;
  }

  function card(code, f) {
    const today = changeSince(f.points, istMidnight(now()));
    const week = changeSince(f.points, now() - 7 * 86_400);
    const box = el('div', `fd-card${code === R.sel ? ' sel' : ''}`);
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-pressed', String(code === R.sel));
    const pick = () => {
      R.sel = code; R.showOpen = 20; R.showClosed = 30; R.closedFilter = '';
      try { localStorage.setItem('whaleLab.fund', code); } catch { /* not kept; fine */ }
      render();
    };
    box.addEventListener('click', pick);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    const name = el('div', 'fd-name');
    name.append(el('span', 'fd-code', code), el('span', null, f.name));
    box.append(name);
    box.append(el('div', 'fd-eq', usd(f.equity)));
    box.append(el('div', `fd-pnl ${tone(f.pnl)}`, `${signed(f.pnl)} (${f.pnl >= 0 ? '+' : ''}${(f.pnl / f.start * 100).toFixed(1)}%) since start`));
    const mini = el('div', 'fd-mini');
    for (const [label, v, cls] of [['Today', signed(today), tone(today)], ['Last 7 days', signed(week), tone(week)],
      ['Worst dip', f.max_dd ? `-$${dollars(f.max_dd)}` : '$0.00', f.max_dd ? 'neg' : 'mut']]) {
      const c = el('div');
      c.append(el('span', null, label), el('b', cls, v));
      mini.append(c);
    }
    box.append(mini);
    box.append(el('p', 'fd-facts', `Cash ${usd(f.cash)} · ${f.open_n} open ${f.open_n === 1 ? 'bet' : 'bets'} worth `
      + `${usd(f.in_bets)} · ${f.copied} copied so far`));
    box.append(el('p', 'fd-facts', f.closed_n
      ? `Closed ${f.closed_n}: won ${f.won} (${pct(f.win_rate)}; the prices paid implied ${pct(f.baseline)}) · booked ${signed(f.realized)}`
      : 'Nothing closed yet.'));
    return box;
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  function chart(F) {
    const box = el('div', 'fd-chart');
    box.append(el('h3', null, 'Equity, both funds'));
    const series = Object.entries(F.funds).map(([code, f]) => ({ code, f, pts: f.points || [] }));
    const all = series.flatMap((s) => s.pts);
    if (all.length < 3 || series.every((s) => s.pts.length < 2)) {
      box.append(el('p', 'tiny', 'The line starts after the next update.'));
      return box;
    }
    const start = series[0].f.start;
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
    let lo = Math.min(start, ...all.map((p) => p[1])), hi = Math.max(start, ...all.map((p) => p[1]));
    const pad = Math.max((hi - lo) * 0.12, 2);
    lo -= pad; hi += pad;
    const W = 600, H = 170;
    const X = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : W);
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
      'aria-label': `Equity of both funds since ${niceDate(istDay(t0))}` });
    svg.append(svgEl('line', { x1: 0, x2: W, y1: Y(start), y2: Y(start), stroke: '#5a5852',
      'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }));
    // the fund being read is drawn last, on top, in the brand colour
    for (const s of [...series].sort((a, b) => (a.code === R.sel) - (b.code === R.sel))) {
      if (s.pts.length < 2) continue;
      const d = s.pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      svg.append(svgEl('path', { d, fill: 'none', stroke: s.code === R.sel ? COLOR_SEL : COLOR_OTHER,
        'stroke-width': s.code === R.sel ? 2.5 : 1.75, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    box.append(svg);
    const axis = el('div', 'fd-axis');
    axis.append(el('span', null, `${shortDate(istDay(t0))} ${istClock(t0)}`), el('span', null, `${when(t1)} IST`));
    box.append(axis);
    const legend = el('div', 'fd-legend');
    for (const s of series) {
      const item = el('span');
      const sw = el('span', 'fd-sw');
      sw.style.background = s.code === R.sel ? COLOR_SEL : COLOR_OTHER;
      item.append(sw, `${s.code} · ${s.f.name}: ${usd(s.f.equity)}`);
      legend.append(item);
    }
    const dash = el('span');
    const dsw = el('span', 'fd-sw dash');
    dash.append(dsw, `the $${start.toLocaleString('en-US')} start`);
    legend.append(dash);
    box.append(legend);
    box.append(el('p', 'tiny', `High ${usd(Math.max(...all.map((p) => p[1])))} · low ${usd(Math.min(...all.map((p) => p[1])))}. `
      + 'One reading per update, so a dip between updates is not drawn.'));
    return box;
  }

  function table(head, rows) {
    const wrap = el('div', 'fd-tablewrap');
    const t = el('table', 'fd-table');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', null, h));
    const thead = el('thead');
    thead.append(tr);
    const tbody = el('tbody');
    for (const cells of rows) {
      const r = el('tr');
      for (const c of cells) {
        const td = el('td');
        if (Array.isArray(c)) td.append(...c);
        else td.append(c);
        r.append(td);
      }
      tbody.append(r);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  function moneyCell(v) {
    return el('span', tone(v), signed(v));
  }

  function equityCell(eq, change) {
    if (eq == null) return '—';
    return [usd(eq), el('small', tone(change), signed(change))];
  }

  function dayTable(f) {
    const box = el('div');
    box.append(el('h3', null, 'Day by day'));
    const today = istDay(now());
    const list = f.days.slice(0, R.allDays ? 400 : 14);
    if (!list.length) { box.append(el('p', 'empty', 'No days yet.')); return box; }
    box.append(table(['Day', 'Copied', 'Won', 'Booked', 'Equity'], list.map((d) => [
      `${niceDate(d.date)}${d.date === today ? ' · today' : ''}`,
      d.missed ? [`${d.copied || 0}`, el('small', 'neg', `+${d.missed} missed`)] : `${d.copied || 0}`,
      d.closed ? `${d.won} of ${d.closed}` : '—',
      d.closed ? moneyCell(d.realized) : '—',
      equityCell(d.equity, d.change),
    ])));
    if (f.days.length > 14) {
      const more = el('button', 'btn small', R.allDays ? 'Show the last 14 days' : `Show all ${f.days.length} days`);
      more.type = 'button';
      more.addEventListener('click', () => { R.allDays = !R.allDays; render(); });
      box.append(more);
    }
    box.append(el('p', 'tiny', 'Days are India time. "Booked" is the profit of bets that finished that day. "Equity" is '
      + 'cash plus open bets at the day\'s last update, and its change from the day before includes bets still open.'));
    return box;
  }

  function weekTable(f) {
    const ws = weeks(f.days, f.start);
    if (ws.length < 2) return null;
    const box = el('div');
    box.append(el('h3', null, 'Week by week'));
    box.append(table(['Week from', 'Copied', 'Won', 'Booked', 'Equity'], ws.map((w) => [
      niceDate(w.week),
      `${w.copied}`,
      w.closed ? `${w.won} of ${w.closed}` : '—',
      w.closed ? moneyCell(w.realized) : '—',
      equityCell(w.equity, w.change),
    ])));
    return box;
  }

  function catTable(f) {
    if (!f.cats?.length) return null;
    const box = el('div');
    box.append(el('h3', null, 'Where the money came from'));
    box.append(table(['Topic', 'Won', 'Booked', 'A minute late'], f.cats.map((c) => [
      CAT_LABEL[c.category] || 'Other',
      `${c.won} of ${c.closed}`,
      moneyCell(c.realized),
      c.late_n ? moneyCell(c.late) : '—',
    ])));
    box.append(el('p', 'tiny', 'Closed bets only, by topic. The last column scores the same bets copied a minute after '
      + 'the whale; in a 5-minute "Up or Down" market a minute is a fifth of its life, which is where most of that gap comes from.'));
    return box;
  }

  function lateNote(f) {
    const box = el('div', 'rc-head fd-late');
    box.append(el('h3', null, 'What a minute of delay costs'));
    if (!f.late_n) {
      box.append(el('p', 'tiny', 'Shown once bets close. Each copy also records the price one minute after the '
        + 'whale traded, and is scored again at that price.'));
      return box;
    }
    const p = el('p', 'rc-copy');
    p.append(`On ${f.late_n} closed ${f.late_n === 1 ? 'bet' : 'bets'}: copied in the same second `,
      el('b', tone(f.late_same), signed(f.late_same)), ', copied a minute late ',
      el('b', tone(f.late_pnl), signed(f.late_pnl)), '.');
    box.append(p);
    box.append(el('p', 'tiny', 'The fund itself is scored at the same-second price, the best case. A real copy '
      + 'that waits on a phone alert lands nearer the second number, or later.'));
    return box;
  }

  function openRow(p) {
    const li = el('li', 'row rc-row');
    const who = el('div', 'who');
    who.append(whaleName(p.whale, p.whale_name));
    who.append(el('span', 'rc-pill open', p.settling ? 'SETTLING' : 'OPEN'));
    if (p.category && CAT_LABEL[p.category]) who.append(el('span', 'tag', CAT_LABEL[p.category]));
    li.append(who);
    const right = el('div');
    right.append(el('div', `headline-num ${tone(p.pnl_now)}`, signed(p.pnl_now)));
    right.append(el('div', 'headline-sub', p.settling ? 'decided, paying soon' : 'if sold now'));
    li.append(right);
    const says = el('div', 'says');
    const sold = p.sold_frac > 0.001 ? ` · sold ${Math.round(p.sold_frac * 100)}% with the whale` : '';
    says.append(el('span', 'when', when(p.ts)), ` bought "${p.outcome || '?'}" at ${cents(p.price)} → now `,
      el('b', null, cents(p.mark ?? p.price)), sold);
    li.append(says);
    const mk = marketLine(p);
    if (p.end_ts) mk.append(el('span', 'tag', p.end_ts * 1000 < Date.now() ? 'past its end date' : `ends ${when(p.end_ts)}`));
    li.append(mk);
    return li;
  }

  function closedText(c) {
    if (c.how === 'sold') return `the whale sold, so it sold at ${cents(c.exit)}`;
    const end = c.payout === 1 ? 'won, paid $1 a share' : 'lost, worth 0';
    return c.sold_frac > 0.001 ? `sold ${Math.round(c.sold_frac * 100)}% at ${cents(c.exit)}, the rest ${end}` : end;
  }

  function closedRow(c) {
    const li = el('li', 'row rc-row');
    const who = el('div', 'who');
    who.append(whaleName(c.whale, c.whale_name), el('span', `rc-pill ${c.won ? 'won' : 'lost'}`, c.won ? 'WON' : 'LOST'));
    if (c.category && CAT_LABEL[c.category]) who.append(el('span', 'tag', CAT_LABEL[c.category]));
    li.append(who);
    const right = el('div');
    right.append(el('div', `headline-num ${tone(c.pnl)}`, signed(c.pnl)));
    right.append(el('div', 'headline-sub', c.late_pnl == null ? 'on $10' : `a minute late: ${signed(c.late_pnl)}`));
    li.append(right);
    const says = el('div', 'says');
    says.append(el('span', 'when', when(c.ts)), ` bought "${c.outcome || '?'}" at ${cents(c.price)} → `,
      el('b', null, closedText(c)), ` · ${when(c.close_ts)}`);
    li.append(says, marketLine(c));
    return li;
  }

  function openList(f) {
    const box = el('div');
    box.append(el('h3', null, `Open bets (${f.open.length})`));
    if (!f.open.length) { box.append(el('p', 'empty', 'No open bets.')); return box; }
    const ul = el('ul', 'tape');
    for (const p of f.open.slice(0, R.showOpen)) ul.append(openRow(p));
    box.append(ul);
    if (f.open.length > R.showOpen) {
      const more = el('button', 'btn', `Show ${Math.min(20, f.open.length - R.showOpen)} more`);
      more.type = 'button';
      more.addEventListener('click', () => { R.showOpen += 20; render(); });
      box.append(more);
    }
    return box;
  }

  function closedList(f) {
    const box = el('div');
    const rows = f.closed.filter((c) => !R.closedFilter || (R.closedFilter === 'won') === c.won);
    box.append(el('h3', null, `Closed bets (${f.closed.length}${f.closed_n > f.closed.length ? ` most recent of ${f.closed_n}` : ''})`));
    const bar = el('div', 'chips scroller');
    for (const [v, label] of [['', 'All'], ['won', 'Won'], ['lost', 'Lost']]) {
      const b = el('button', `chip${v === R.closedFilter ? ' active' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', () => { R.closedFilter = v; R.showClosed = 30; render(); });
      bar.append(b);
    }
    box.append(bar);
    if (!rows.length) { box.append(el('p', 'empty', f.closed.length ? 'None match.' : 'Nothing closed yet.')); return box; }
    const ul = el('ul', 'tape');
    for (const c of rows.slice(0, R.showClosed)) ul.append(closedRow(c));
    box.append(ul);
    if (rows.length > R.showClosed) {
      const more = el('button', 'btn', `Show ${Math.min(30, rows.length - R.showClosed)} more`);
      more.type = 'button';
      more.addEventListener('click', () => { R.showClosed += 30; render(); });
      box.append(more);
    }
    return box;
  }

  function skips(f, code) {
    const parts = [`${f.copied} copied`, `${f.skipped_held} skipped because the fund already held that outcome`];
    if (code === 'B') parts.push(`${f.skipped_filter} skipped because the market ends later than 2 days out`);
    parts.push(`${f.missed_cash} missed for lack of cash`, `${usd(f.fees)} paid in fees`);
    return el('p', 'tiny', `${parts.join(' · ')}.`);
  }

  function render() {
    if (!root || state.view !== 'fund') return;
    const y = window.scrollY;
    root.replaceChildren();
    const F = R.doc;
    if (!F) {
      root.append(el('p', 'empty', R.missing
        ? 'The paper funds open on the pipeline\'s next run; this page fills in after that.'
        : 'Loading the paper funds…'));
      return;
    }
    root.append(statusLine(F));
    const cards = el('div', 'fd-cards');
    for (const [code, f] of Object.entries(F.funds)) cards.append(card(code, f));
    root.append(cards);
    const f = F.funds[R.sel];
    const nothingYet = Object.values(F.funds).every((x) => !x.copied && !x.open_n && !x.closed_n);
    if (nothingYet) {
      root.append(el('p', 'empty', 'No copies yet. The funds read the whales\' trades on each pipeline run, every '
        + 'few hours, and time every copy to the second the whale traded, so nothing is lost by waiting.'));
    }
    root.append(chart(F));
    const head = el('h3', 'fd-sel', `${R.sel} · ${f.name}`);
    root.append(head);
    if (f.missed_cash && f.cash < 11) {
      root.append(el('p', 'hint fd-full', `Fund ${R.sel} is fully invested: ${usd(f.cash)} cash, ${f.open_n} bets open. `
        + `New signals are missed (${f.missed_cash} so far) until bets close and pay back.`));
    }
    for (const part of [dayTable(f), weekTable(f), catTable(f), lateNote(f), openList(f), closedList(f), skips(f, R.sel)]) {
      if (part) root.append(part);
    }
    window.scrollTo({ top: y });
  }

  // Called every second by the app while this view is open; reads the file at
  // most every 30 s, and not at all in a background tab after the first load.
  function tick() {
    if (state.view !== 'fund') return;
    const first = !R.polledAt;
    if (document.hidden && !first) return;
    if (first || Date.now() - R.polledAt > POLL_MS) { R.polledAt = Date.now(); load(); }
  }

  return { render, tick, state: R, generatedAt: () => R.doc?.generated_at };
}
