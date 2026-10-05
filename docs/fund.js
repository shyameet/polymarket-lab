/* Paper fund — two $1,000 paper accounts that copy the worth-following whales by rule.
 *
 * pipeline/pm/fund.py replays every whale fill since its last run, in time order,
 * the way a bot watching live would have traded it, and writes data/fund/fund.json
 * (about every 15 minutes: .github/workflows/fund.yml paces itself). The books come from that
 * one ledger only. The "Being copied right now" strip is a preview: it reads the
 * whales' trades since the last update through the relay and applies the same
 * rules, so what the next update will book is visible before it lands.
 *
 * Every copy is filled at the whale's own price in the same second — the best
 * case. Beside it sits the same trade copied a minute late, so the cost of a real
 * delay is on the page instead of hidden.
 */

const IST_S = 19_800;                       // +05:30, no daylight saving
const istDay = (ts) => new Date((ts + IST_S) * 1000).toISOString().slice(0, 10);
const istClock = (ts) => new Date((ts + IST_S) * 1000).toISOString().slice(11, 16);
const POLL_MS = 30_000;
const LIVE_EVERY_MS = 10 * 60_000;          // ~200 relay requests a check, so not more often
const SIGNAL_USD = 100;                     // the fund's signal: $100 of one outcome in one day
const STAKE = 10;
const COLOR_SEL = '#e97132';                // the brand orange: the fund being read
const COLOR_OTHER = '#8a8780';              // the other fund, in neutral grey

/** Relay REST URL. The nonce misses the upstream 5-minute CDN cache (as in recap.js). */
export function relayURLFor(relay, host, path, params, nowMs = Date.now()) {
  const u = new URL(`${relay.replace(/\/+$/, '')}/api/${host}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('_', String(nowMs));
  return u.href;
}

/** Whale fills after `since` -> what the next update will most likely book, by the
 *  fund's own rules. rows: /activity rows with `wallet` and `name` added.
 *  held: token -> fund codes already holding it. copying: `${wallet}|${token}` ->
 *  fund codes whose copy follows that whale. A buy signal is a whale's buys of one
 *  outcome in one India-time day reaching $100, counted from `since` only (a whale
 *  part-way there before `since` is missed here, not by the fund, which carries
 *  the earlier part). Only the first whale to cross on an outcome is copied. */
export function pendingMoves(rows, since, held = new Map(), copying = new Map()) {
  const fills = rows.filter((r) => r.type === 'TRADE' && Number(r.timestamp) > since
    && Number(r.size) > 0 && r.asset)
    .sort((a, b) => a.timestamp - b.timestamp || (a.side === 'BUY' ? -1 : 1));
  const eps = new Map(), signals = new Map(), sells = [];
  for (const r of fills) {
    const size = Number(r.size), tok = String(r.asset);
    const usd = Number(r.usdcSize) || size * (Number(r.price) || 0);
    const price = Number(r.price) || usd / size;
    const base = { wallet: r.wallet, name: r.name || '', token: tok, condition: r.conditionId || '',
      outcome: r.outcome || '', title: r.title || '', slug: r.slug || '', ts: Number(r.timestamp), price };
    if (r.side === 'SELL') {
      const funds = copying.get(`${r.wallet}|${tok}`);
      if (funds?.size) sells.push({ ...base, usd, funds: [...funds].sort() });
      continue;
    }
    if (r.side !== 'BUY' || base.condition.length !== 66 || (!base.outcome && / AND /.test(base.title))) continue;
    const key = `${r.wallet}|${tok}|${istDay(base.ts)}`;
    const ep = eps.get(key) || { usd: 0, done: false };
    ep.usd += usd;
    eps.set(key, ep);
    if (ep.done || ep.usd < SIGNAL_USD) continue;
    ep.done = true;
    if (!(price > 0.001 && price < 0.999)) continue;
    const s = signals.get(tok);
    if (s) { s.others += 1; continue; }
    signals.set(tok, { ...base, usd: ep.usd, others: 0, held: [...(held.get(tok) || [])].sort() });
  }
  return { signals: [...signals.values()], sells };
}

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

/** The paper funds A, B and C plus the real-price funds D, E, F and G when their file is there: each
 *  copies its paper fund's signals (D←A, E←B, F←C; G←A without longshots) at the prices the order book really offered,
 *  built from the copy-price recorder. A file written before E and F carries D alone as `fund`.
 *  They join the cards, the chart and the details, never the live preview: their copies come from
 *  the recorder's own feed, not from this page's check. */
export function withD(funds, d) {
  const real = d?.funds || (d?.fund ? { D: d.fund } : {});
  return { ...funds, ...real };
}

/** One fund's rule from fund.json: {max_hours, exclude}. A fund.json written before
 *  2026-10-03 carried only names; B was then the one fund with a rule. */
export function ruleOf(rules, code) {
  const r = rules?.funds?.[code];
  if (r && typeof r === 'object') return { max_hours: r.max_hours ?? null, exclude: r.exclude || [] };
  return { max_hours: code === 'B' ? 48 : null, exclude: [] };
}

/** What one fund will do with a previewed signal, by its rules, as [label, tag class]. */
export function fundCall(code, rule, fund, s, market, cat, catLabel = {}) {
  if (fund.started && s.ts <= fund.started) return [`${code}: opened after this`, 'tag'];
  if (s.held.includes(code)) return [`${code}: already holds it`, 'tag'];
  if (cat && rule.exclude.includes(cat)) return [`${code}: skips ${catLabel[cat] || cat}`, 'tag'];
  if (rule.max_hours != null) {
    if (!market) return [`${code}: end date unknown`, 'tag'];
    if (market.end == null || market.end - s.ts > rule.max_hours * 3600) return [`${code}: ends later, skips`, 'tag'];
  }
  if (fund.cash < STAKE + 0.5) return [`${code}: no cash, misses`, 'tag neg'];
  return [`${code} buys $${STAKE}`, 'tag pos'];
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
const cents1 = (p) => (p == null ? '—' : `${(p * 100).toFixed(1)}¢`);
// Fund D's rows carry the whale's own price beside the one the order book gave
const paid = (r) => (r.whale_price != null ? `${cents1(r.price)} (the whale ${cents1(r.whale_price)})` : cents(r.price));
const dollars = (v) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${dollars(v)}`);
const signed = (v) => (v == null ? '—' : `${v > 0.004 ? '+' : v < -0.004 ? '-' : ''}$${dollars(v)}`);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const tone = (v) => (v == null || Math.abs(v) < 0.005 ? 'mut' : v > 0 ? 'pos' : 'neg');

export function initFund(ctx) {
  const { state, el, displayName, ago, snapshotJSON, marketLink, copyMarketBtn, openDrawer, CAT_LABEL,
    relayURL, categorize } = ctx;
  let saved = 'A';
  try { saved = localStorage.getItem('whaleLab.fund') || 'A'; } catch { /* private window: default */ }
  const R = { doc: null, d: null, missing: false, sel: saved, closedFilter: '', showOpen: 20, showClosed: 30,
    allDays: false, polledAt: 0, live: null, liveBusy: false, liveAll: false };
  const root = document.querySelector('#fund-root');
  const now = () => Math.floor(Date.now() / 1000);
  const when = (ts) => (istDay(ts) === istDay(now()) ? istClock(ts) : `${shortDate(istDay(ts))} ${istClock(ts)}`);
  const all = () => (R.doc ? withD(R.doc.funds, R.d) : {});

  async function load() {
    try {
      // Fund D's file is optional: without it the page is exactly the three funds
      const [doc, d] = await Promise.all([snapshotJSON('data/fund/fund.json'),
        snapshotJSON('data/fund_d.json').catch(() => null)]);
      if (d && d.fund) R.d = d;
      if (doc && doc.funds) {
        R.doc = doc;
        R.missing = false;
      }
      if (R.doc && !all()[R.sel]) R.sel = Object.keys(R.doc.funds)[0];
      if ((doc && doc.funds) || (d && d.fund)) render();
    } catch {
      // not written yet (the pipeline opens the funds on its first run) or mid-deploy
      R.missing = true;
      if (!R.doc) render();
    }
  }

  /* ── live preview: the whales' trades since the last update, through the relay ── */
  async function liveCheck(force = false) {
    const F = R.doc, relay = relayURL?.();
    if (!F || !relay || R.liveBusy || (document.hidden && !force)) return;
    const since = F.cursor;
    if (!force && R.live && R.live.since === since && Date.now() - R.live.at < LIVE_EVERY_MS) return;
    R.liveBusy = true;
    render();
    const until = now();
    const held = new Map(), copying = new Map();
    const add = (m, k, code) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(code); };
    for (const [code, f] of Object.entries(F.funds)) {
      for (const p of f.open) {
        if (!p.token) continue;
        add(held, p.token, code);
        add(copying, `${p.whale}|${p.token}`, code);
      }
    }
    // the whales the funds follow, plus any it still holds a copy of
    const whales = new Map(state.whales.filter((c) => c.verdict === 'CANDIDATE')
      .map((c) => [(c.wallet || '').toLowerCase(), c.name || '']));
    for (const k of copying.keys()) if (!whales.has(k.split('|')[0])) whales.set(k.split('|')[0], '');
    const get = async (host, path, params) => {
      const r = await fetch(relayURLFor(relay, host, path, params),
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const rows = [];
    let failed = 0;
    const queue = [...whales.entries()];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const [wallet, name] = queue.shift();
        try {
          const page = await get('data', '/activity',
            { user: wallet, limit: 500, type: 'TRADE', start: since + 1, end: until });
          for (const r of Array.isArray(page) ? page : []) rows.push({ ...r, wallet, name: name || r.name || '' });
        } catch { failed += 1; }
      }
    }));
    const moves = pendingMoves(rows, since, held, copying);
    // each new signal's market: its price now, and its end date (fund B's rule)
    const markets = new Map();
    const cq = [...new Set(moves.signals.map((s) => s.condition))].slice(0, 30);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cq.length) {
        const cid = cq.shift();
        try {
          const m = await get('clob', `/markets/${cid}`, {});
          markets.set(cid, { end: m.end_date_iso ? Math.floor(Date.parse(m.end_date_iso) / 1000) : null,
            prices: new Map((m.tokens || []).map((t) => [String(t.token_id), Number(t.price)])) });
        } catch { /* shown without its price and end date */ }
      }
    }));
    R.live = { since, until, at: Date.now(), ...moves, markets, failed, asked: whales.size };
    R.liveBusy = false;
    render();
  }

  function fundCalls(s, L) {
    const m = L.markets.get(s.condition);
    const cat = categorize ? categorize(s.title, s.slug) : null;
    return Object.entries(R.doc.funds).map(([code, f]) =>
      fundCall(code, ruleOf(R.doc.rules, code), f, s, m, cat, CAT_LABEL));
  }

  function liveRow(r, L) {
    const li = el('li', 'row rc-row');
    const who = el('div', 'who');
    who.append(whaleName(r.wallet, r.name), el('span', `side ${r.kind === 'buy' ? 'BUY' : 'SELL'}`,
      r.kind === 'buy' ? 'BOUGHT' : 'SOLD'));
    if (r.kind === 'buy') {
      for (const [text, cls] of fundCalls(r, L)) who.append(el('span', cls, text));
      if (r.others) who.append(el('span', 'tag stack', `+${r.others} more ${r.others === 1 ? 'whale' : 'whales'}`));
    } else {
      for (const code of r.funds) who.append(el('span', 'tag pos', `${code} sells with it`));
    }
    li.append(who, el('div', 'headline-num', usd(r.usd)));
    const says = el('div', 'says');
    const nowPx = L.markets.get(r.condition)?.prices.get(r.token);
    says.append(el('span', 'when', when(r.ts)), r.kind === 'buy'
      ? ` "${r.outcome || '?'}" at ${cents(r.price)}${nowPx != null ? ` · now ${cents(nowPx)}` : ''}`
      : ` "${r.outcome || '?'}" at ${cents(r.price)}: the copy sells the same share of what it holds`);
    li.append(says, marketLine(r));
    return li;
  }

  function livePanel(F) {
    const box = el('div', 'rc-new fd-live');
    const head = el('div', 'rc-htop');
    head.append(el('h3', null, 'Being copied right now'));
    const btn = el('button', 'btn small', R.liveBusy ? 'Checking…' : 'Check now');
    btn.type = 'button';
    btn.disabled = R.liveBusy || !relayURL?.();
    btn.addEventListener('click', () => liveCheck(true));
    head.append(btn);
    box.append(head);
    if (!relayURL?.()) {
      box.append(el('p', 'tiny', 'The live check needs the relay (see Data source).'));
      return box;
    }
    const L = R.live;
    if (!L || L.since !== F.cursor) {
      box.append(el('p', 'tiny', R.liveBusy ? `Reading the whales' trades since ${when(F.cursor)} IST…`
        : 'Not checked yet.'));
      return box;
    }
    box.append(el('p', 'tiny', `Whale trades since the last update (${when(L.since)} IST), checked `
      + `${ago(Math.floor(L.at / 1000))} ago${L.failed ? ` · ${L.failed} whales did not answer` : ''}. A preview: the `
      + 'next update books these at the times and prices shown.'));
    const rows = [...L.signals.map((s) => ({ ...s, kind: 'buy' })), ...L.sells.map((s) => ({ ...s, kind: 'sell' }))]
      .sort((a, b) => b.ts - a.ts);
    if (!rows.length) {
      box.append(el('p', 'tiny', 'No new signals or exits since then.'));
      return box;
    }
    const ul = el('ul', 'tape');
    for (const r of rows.slice(0, R.liveAll ? 80 : 8)) ul.append(liveRow(r, L));
    box.append(ul);
    if (rows.length > 8) {
      const more = el('button', 'btn small', R.liveAll ? 'Show fewer' : `Show all ${Math.min(80, rows.length)}`);
      more.type = 'button';
      more.addEventListener('click', () => { R.liveAll = !R.liveAll; render(); });
      box.append(more);
    }
    return box;
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
    if (f.mirror) box.append(el('div', 'fd-since', `Real prices · fund ${f.mirror}'s signals`));
    // a fund added later says when its own record starts
    if (f.started && R.doc?.started && f.started - R.doc.started > 600) {
      box.append(el('div', 'fd-since', `Opened ${niceDate(istDay(f.started))}, ${istClock(f.started)} IST`));
    }
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
    if (f.twin) {
      box.append(el('p', 'fd-facts', `At the whale's own prices the same copies: ${signed(f.twin.pnl)}. `
        + `Real prices cost ${Math.round(f.cost_cents)}¢ a copy.`));
    }
    return box;
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  /* ── H: the fair test (owner, 5 Oct): two books opened together with $1,000 each that take exactly the same
   *  copies; one pays the whale's own price, the other the order book's. One card, both books side by side. ── */
  function pairCard(code, f) {
    const box = el('div', `fd-card fd-pair${code === R.sel ? ' sel' : ''}`);
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
    box.append(el('div', 'fd-since', `Opened ${niceDate(istDay(f.started))}, ${istClock(f.started)} IST · `
      + `$${f.start.toLocaleString('en-US')} in each book · ${ruleText(f)} our server's recorder catches`));
    const two = el('div', 'fd-two');
    for (const [label, eq, pnl, cls] of [['At the whale\'s price', f.twin.equity, f.twin.pnl, 'whale'],
      ['At the real price', f.equity, f.pnl, 'real']]) {
      const side = el('div', `fd-side ${cls}`);
      side.append(el('span', 'fd-side-k', label), el('div', 'fd-eq', usd(eq)),
        el('div', `fd-pnl ${tone(pnl)}`, `${signed(pnl)} since the opening`));
      two.append(side);
    }
    box.append(two);
    const ch = pairChart(f);
    if (ch) box.append(ch);
    box.append(el('p', 'fd-facts', f.copied
      ? `The same ${f.copied} ${f.copied === 1 ? 'copy' : 'copies'} in both books, with the same exits and settlements, `
        + `so the gap is the price alone: ${Math.round(f.cost_cents)}¢ a copy · ${f.open_n} open · ${f.closed_n} closed`
      : 'No copies yet. Both books take the first signal after the opening together.'));
    return box;
  }

  function pairChart(f) {
    const a = f.twin?.points || [], b = f.points || [];
    if (a.length < 2 && b.length < 2) return null;
    const all = [...a, ...b];
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
    let lo = Math.min(f.start, ...all.map((p) => p[1])), hi = Math.max(f.start, ...all.map((p) => p[1]));
    const pad = Math.max((hi - lo) * 0.12, 2);
    lo -= pad; hi += pad;
    const W = 600, H = 110;
    const X = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : W);
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
      'aria-label': 'Both books since the opening: the whale\'s price and the real price' });
    svg.append(svgEl('line', { x1: 0, x2: W, y1: Y(f.start), y2: Y(f.start), stroke: '#5a5852',
      'stroke-dasharray': '4 4', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    const line = (pts, color, width, dash) => {
      if (pts.length < 2) return;
      const attrs = { d: pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(''),
        fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
      if (dash) attrs['stroke-dasharray'] = dash;
      svg.append(svgEl('path', attrs));
    };
    line(a, COLOR_OTHER, 2, '6 4');          // the whale's price
    line(b, COLOR_SEL, 2.5, '');             // the real price
    const wrap = el('div', 'fd-pairwrap');
    wrap.append(svg);
    const legend = el('div', 'fd-legend');
    for (const [text, bg] of [['at the whale\'s price', `repeating-linear-gradient(90deg, ${COLOR_OTHER} 0 6px, transparent 6px 10px)`],
      ['at the real price', COLOR_SEL]]) {
      const item = el('span');
      const sw = el('span', 'fd-sw');
      sw.style.background = bg;
      item.append(sw, text);
      legend.append(item);
    }
    legend.append(el('span', null, `${shortDate(istDay(t0))} ${istClock(t0)} to ${when(t1)} IST`));
    wrap.append(legend);
    return wrap;
  }

  // The fund being read is the brand orange; the others are grey, told apart by
  // their line pattern (solid, dotted, dashed), never by a second colour.
  const OTHER_DASH = ['', '2 4', '7 4', '1 3', '10 3 2 3'];
  function lineStyle(series, code) {
    if (code === R.sel) return { color: COLOR_SEL, dash: '' };
    const i = series.filter((s) => s.code !== R.sel).findIndex((s) => s.code === code);
    return { color: COLOR_OTHER, dash: OTHER_DASH[i] || '' };
  }

  function chart(F) {
    const box = el('div', 'fd-chart');
    box.append(el('h3', null, 'Equity of the funds'));
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
      'aria-label': `Equity of the funds since ${niceDate(istDay(t0))}` });
    svg.append(svgEl('line', { x1: 0, x2: W, y1: Y(start), y2: Y(start), stroke: '#5a5852',
      'stroke-dasharray': '4 4', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    // the fund being read is drawn last, on top, in the brand colour
    for (const s of [...series].sort((a, b) => (a.code === R.sel) - (b.code === R.sel))) {
      if (s.pts.length < 2) continue;
      const d = s.pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      const look = lineStyle(series, s.code);
      const attrs = { d, fill: 'none', stroke: look.color, 'stroke-width': s.code === R.sel ? 2.5 : 1.75,
        'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
      if (look.dash) attrs['stroke-dasharray'] = look.dash;
      svg.append(svgEl('path', attrs));
    }
    box.append(svg);
    const axis = el('div', 'fd-axis');
    axis.append(el('span', null, `${shortDate(istDay(t0))} ${istClock(t0)}`), el('span', null, `${when(t1)} IST`));
    box.append(axis);
    const legend = el('div', 'fd-legend');
    for (const s of series) {
      const item = el('span');
      const sw = el('span', 'fd-sw');
      const look = lineStyle(series, s.code);
      const [on, off] = look.dash ? look.dash.split(' ').map(Number) : [0, 0];
      sw.style.background = look.dash
        ? `repeating-linear-gradient(90deg, ${look.color} 0 ${on}px, transparent ${on}px ${on + off}px)`
        : look.color;
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
    says.append(el('span', 'when', when(p.ts)), ` bought "${p.outcome || '?'}" at ${paid(p)} → now `,
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
    right.append(el('div', 'headline-sub', c.twin_pnl != null ? `at the whale's price ${signed(c.twin_pnl)}`
      : c.late_pnl == null ? 'on $10' : `a minute late: ${signed(c.late_pnl)}`));
    li.append(right);
    const says = el('div', 'says');
    says.append(el('span', 'when', when(c.ts)), ` bought "${c.outcome || '?'}" at ${paid(c)} → `,
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
    const rule = ruleOf(R.doc.rules, code);
    const parts = [`${f.copied} copied`, `${f.skipped_held} skipped because the fund already held that outcome`];
    if (rule.max_hours != null) {
      parts.push(`${f.skipped_filter} skipped because the market ends later than ${rule.max_hours / 24} days out`);
    }
    if (rule.exclude.length) {
      parts.push(`${f.skipped_filter} skipped as ${rule.exclude.map((c) => CAT_LABEL[c] || c).join(', ')} markets`);
    }
    parts.push(`${f.missed_cash} missed for lack of cash`, `${usd(f.fees)} paid in fees`);
    return el('p', 'tiny', `${parts.join(' · ')}.`);
  }

  /* ── D, E and F: the same copies at the prices the order book really offered ── */
  function ruleText(f) {
    const r = f.rule || {};
    if (r.min_price != null) return `every signal except where the whale paid under ${Math.round(r.min_price * 100)}¢`;
    if (r.max_hours != null) return `markets scheduled to end within ${r.max_hours / 24} days`;
    if (r.exclude?.length) return `every signal except ${r.exclude.map((c) => CAT_LABEL[c] || c).join(', ')} markets`;
    return 'every signal';
  }

  function dNote(f, code) {
    const d = R.d;
    const box = el('div', 'rc-head fd-late');
    box.append(el('h3', null, 'What real prices cost'));
    const p = el('p', 'rc-copy');
    p.append(`The same ${f.copied} copies with the same exits: at the whale's own prices `,
      el('b', tone(f.twin.pnl), signed(f.twin.pnl)), ', at the prices the order book really offered ',
      el('b', tone(f.pnl), signed(f.pnl)), `, so ${Math.round(f.cost_cents)}¢ a copy.`);
    if (f.open_n && f.in_bets_quoted != null) {
      p.append(` Its ${f.open_n} open ${f.open_n === 1 ? 'bet' : 'bets'} would sell for ${usd(f.in_bets)} right now `
        + `(${usd(f.in_bets_quoted)} at Polymarket's quoted price).`);
    }
    box.append(p);
    const mk = d.match && Object.keys(d.match).sort().pop();
    const caught = mk ? ` On ${niceDate(mk)} the recorder caught ${d.match[mk].caught} of the paper funds' `
      + `${d.match[mk].funds} copyable signals${d.match[mk].partial ? ' (it ran for part of that day)' : ''}.` : '';
    const own = f.rule?.min_price != null;
    box.append(el('p', 'tiny', `Fund ${code} uses ${own ? `its own rule on fund ${f.mirror}'s signals`
      : `fund ${f.mirror || 'A'}'s rule`} (${ruleText(f)}) on the signals the `
      + 'copy-price recorder on our server caught, and prices every buy and sell from the live order book at the '
      + 'moment it heard the whale\'s trade (about 0.1–0.2 s after it): $10 walked through the real sell orders, a '
      + 'sale through the real buy orders. No fill price is estimated; a copy or sale the recorder could not price is '
      + 'left out of both columns. '
      + (d.valuation_note || 'Bets still open are valued at Polymarket\'s quoted price now, as in A, B and C, not at what '
        + 'selling into the buy orders would get.')
      + `${caught} Rebuilt about every 15 minutes while its publisher `
      + `runs (last ${ago(d.generated_at)} ago, whale trades up to ${when(d.last)} IST), copies from `
      + `${niceDate(istDay(f.started || d.first))} ${istClock(f.started || d.first)} IST. ${d.fee_note}`));
    return box;
  }

  /* ── G: the one rule the data analytics kept, tested forward; every other candidate watched ── */
  const VERDICT = {
    'too early': 'too early to judge',
    passes: 'PASSES: the bets it skips lose money at real prices (the filter helps; that alone does not mean G makes money)',
    fails: 'FAILS: the bets it skips made money at real prices',
    'not decided': 'not decided yet: losing, but not clearly enough',
  };
  function gPanel(f) {
    const fw = R.d?.forward;
    if (!fw?.verdict) return null;
    const v = fw.verdict;
    const sh = v.shadow;
    const cut = Math.round(fw.min_price * 100);
    const box = el('div', 'rc-head fd-late');
    box.append(el('h3', null, 'Is skipping longshots worth it? The forward test'));
    const p = el('p', 'rc-copy');
    p.append(`Since ${niceDate(istDay(fw.from))} ${istClock(fw.from)} IST, G has made `, el('b', tone(f.pnl), signed(f.pnl)),
      ' at real prices. Fund D, copying every signal over the same hours, made ',
      el('b', tone(fw.d_same_days.real), signed(fw.d_same_days.real)), `. The bets G skips (the whale paid under ${cut}¢), `
      + 'each copied at its real price with no cash limit: ', el('b', tone(sh.real), signed(sh.real)),
      ` on ${sh.closed} closed${sh.open ? `, ${sh.open} still open` : ''}. Verdict: `, el('b', null, VERDICT[v.status] || v.status), '.');
    box.append(p);
    box.append(el('p', 'tiny', `Why this rule: our study of every copy from 21 Sep to 5 Oct searched 447 slices of the `
      + 'bets (by topic, hour, weekday, price and bet size) and 225 whales, and two skeptics re-ran each finding. No topic '
      + 'and no time of day paid once the real copy cost was counted; their rankings flipped from one week to the next. '
      + `One rule held: copies where the whale paid under ${cut}¢ lost in both weeks, after costs, across 91 whales, `
      + `because one 1¢ tick is a large share of a small price. It cuts a loss; it does not make a profit on its own. `
      + `The rule and its verdict were fixed before G opened: after ${v.min_closed} skipped bets have closed and `
      + `${v.min_days} days have passed, it passes if they lost money clearly (t at or below ${v.t_pass}, counting a `
      + 'whale\'s same-day bets as one piece of evidence) and fails if they made money. Until then it keeps running '
      + `(${v.days} days so far). The study's own numbers are not counted. A pass only says the filter cuts a loss; `
      + 'whether copying pays at all is G\'s own result against zero, and so far no real-price fund has paid.'));
    return box;
  }

  function watchPanel() {
    const fw = R.d?.forward;
    if (!fw?.watch?.length) return null;
    const box = el('div');
    box.append(el('h3', null, 'Best topics and times? Every idea, tested forward'));
    box.append(el('p', 'tiny', `Each idea the study tested, now counted on new bets only: every signal since `
      + `${niceDate(istDay(fw.from))} ${istClock(fw.from)} IST, copied at real prices with no cash limit, so no idea `
      + 'crowds out another. In brackets: what the study found. t is how clearly a result differs from zero '
      + '(roughly, beyond ±2 is unlikely to be luck), counting a whale\'s same-day bets as one piece of evidence.'));
    const tcell = (t) => (t == null ? '—' : el('span', Math.abs(t) >= 2 ? tone(t) : 'mut', t.toFixed(1)));
    box.append(table(['Idea', 'Closed (won)', 'Real prices', 'Whale\'s price', 't', 'Open'], fw.watch.map((w) => {
      const [name, note] = w.label.split(' [');
      return [[name, note ? el('small', 'mut', ` ${note.replace(/]$/, '')}`) : ''],
        w.closed ? `${w.closed} (${w.won})` : '0', w.closed ? moneyCell(w.real) : '—', w.closed ? moneyCell(w.twin) : '—',
        tcell(w.t), w.open ? `${w.open} · ${signed(w.open_pnl)}` : '0'];
    })));
    box.append(el('p', 'tiny', 'Closed bets only in the money columns; open bets are counted at what they would sell '
      + 'for right now. One bet can sit in several rows (a topic, an hour and a price band).'));
    return box;
  }

  function rulesPanel() {
    const d = R.d;
    if (!d?.rules?.length) return null;
    const box = el('div');
    box.append(el('h3', null, 'Can a copy get the whale\'s exact price?'));
    box.append(el('p', 'tiny', `${d.rules.length} ways to buy, each fixed before the data it is judged on (rules 5 and `
      + '6 from 5 Oct 01:15 IST). The test is the days from 5 Oct (India time). Under each result: the same copies at '
      + 'the whale\'s own price.'));
    const cell = (x) => (x.copies ? [moneyCell(x.real), el('small', 'mut', `${x.copies} copies · whale's price ${signed(x.twin)}`)]
      : '—');
    box.append(table(['How the copy buys', 'Test: from 5 Oct', 'All so far'],
      d.rules.map((r, i) => [`${i + 1}. ${r.label}`, cell(r.fresh), cell(r.so_far)])));
    return box;
  }

  function dCatTable(f) {
    if (!f.cats?.length) return null;
    const box = el('div');
    box.append(el('h3', null, 'Where the money came from'));
    box.append(table(['Topic', 'Won', 'Booked'], f.cats.map((c) => [
      CAT_LABEL[c.category] || 'Other', `${c.won} of ${c.closed}`, moneyCell(c.realized)])));
    box.append(el('p', 'tiny', 'Closed bets only, by topic, at the prices really offered.'));
    return box;
  }

  function dSkips(f, code) {
    const parts = [`${f.copied} copied`, `${f.skipped_held} skipped because the fund already held that outcome`];
    if (f.skipped_filter) {
      const r = f.rule || {};
      const why = r.min_price != null ? `because the whale paid under ${Math.round(r.min_price * 100)}¢ (fund ${code}'s rule)`
        : `${r.max_hours != null ? `because the market ends later than ${r.max_hours / 24} days out`
          : `as ${(r.exclude || []).map((c) => CAT_LABEL[c] || c).join(', ')} markets`} (fund ${f.mirror}'s rule)`;
      parts.push(`${f.skipped_filter} skipped ${why}`);
    }
    parts.push(`${f.unpriced} not priced (no fresh order book within 2 s)`, `${f.late} seen too late to copy`,
      `${f.missed_cash} missed for lack of cash`,
      `${f.exits - f.exit_unpriced - f.exit_late} of ${f.exits} whale sells followed`, `${usd(f.fees)} paid in fees`);
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
    const funds = all();
    // the fair test first (H: one card holding both books), then the two kinds of fund, each in its own row
    const pairs = Object.entries(funds).filter(([, x]) => x.pair && x.twin);
    if (pairs.length) {
      root.append(el('h3', 'fd-group', 'The fair test — same trades, two prices'),
        el('p', 'tiny fd-group-note', 'Two books opened at the same moment with the same cash, taking exactly the same '
          + 'copies of every signal: one pays the whale\'s own price, the other the price the order book really offered. '
          + 'The rows below are separate funds with their own cash and start times, so they hold different trades.'));
      const cards = el('div', 'fd-cards');
      for (const [code, f] of pairs) cards.append(pairCard(code, f));
      root.append(cards);
    }
    const groups = [
      ['Whale\'s price — the best case', 'A, B and C buy and sell at the whale\'s own price, in the same second: '
        + 'what a perfect copy would make. Their fees are a flat 5% estimate and their open bets are valued at the '
        + 'quoted price; D to H use each market\'s real fee and what open bets would sell for right now.',
      Object.entries(funds).filter(([, x]) => !x.twin)],
      ['Real prices — what a copy really gets', 'D, E and F use A\'s, B\'s and C\'s rules on the signals our server\'s '
        + 'recorder caught, priced from the live order book the moment it heard the whale\'s trade (about 0.1–0.2 s '
        + `after it).${funds.G ? ' G is A\'s signals without the longshots (the whale paid under 20¢): the one rule '
          + 'our data analysis kept, tested forward from its own start.' : ''}`,
      Object.entries(funds).filter(([, x]) => x.twin && !x.pair)]];
    const both = groups.every(([, , list]) => list.length);
    for (const [title, note, list] of groups) {
      if (!list.length) continue;
      if (both) root.append(el('h3', 'fd-group', title), el('p', 'tiny fd-group-note', note));
      const cards = el('div', 'fd-cards');
      for (const [code, f] of list) cards.append(card(code, f));
      root.append(cards);
    }
    root.append(livePanel(F));
    const f = funds[R.sel];
    const nothingYet = Object.values(F.funds).every((x) => !x.copied && !x.open_n && !x.closed_n);
    if (nothingYet) {
      root.append(el('p', 'empty', 'No copies in the books yet. Each update replays the whales\' trades since the '
        + 'last one and times every copy to the second the whale traded, so nothing is lost by waiting.'));
    }
    root.append(chart({ ...F, funds }));
    const head = el('h3', 'fd-sel', `${R.sel} · ${f.name}`);
    root.append(head);
    if (f.missed_cash && f.cash < 11) {
      root.append(el('p', 'hint fd-full', `Fund ${R.sel} is fully invested: ${usd(f.cash)} cash, ${f.open_n} bets open. `
        + `New signals are missed (${f.missed_cash} so far) until bets close and pay back.`));
    }
    const parts = f.twin
      ? [dNote(f, R.sel), R.sel === 'D' ? rulesPanel() : null, R.sel === 'G' ? gPanel(f) : null,
        R.sel === 'G' ? watchPanel() : null, dayTable(f), weekTable(f), dCatTable(f), openList(f), closedList(f),
        dSkips(f, R.sel)]
      : [dayTable(f), weekTable(f), catTable(f), lateNote(f), openList(f), closedList(f), skips(f, R.sel)];
    for (const part of parts) {
      if (part) root.append(part);
    }
    window.scrollTo({ top: y });
  }

  // Called every second by the app while this view is open; reads the file at
  // most every 30 s and the whales' newest trades at most every 10 min (or when
  // a new update moves the starting point), never in a background tab after the
  // first load.
  function tick() {
    if (state.view !== 'fund') return;
    const first = !R.polledAt;
    if (document.hidden && !first) return;
    if (first || Date.now() - R.polledAt > POLL_MS) { R.polledAt = Date.now(); load(); }
    if (!document.hidden && state.whales.length) liveCheck();
  }

  return { render, tick, state: R, generatedAt: () => R.doc?.generated_at };
}
