/* Whale research: sampled topic results, observed inventory changes and local
 * forward measurements. No synthetic holding times or historical fill claims.
 * Followability samples watched whales only, while this tab is open. */
export function assessBook(book, entryPrice, budget = 25, tolerance = .02, now = Date.now()) {
  if (!Array.isArray(book?.asks) || !Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1)
    return { state: 'unavailable' };
  const timestamp = Number(book.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 30_000)
    return { state: 'unavailable' };
  const asks = book.asks.map(a => ({ price: Number(a.price), size: Number(a.size) }));
  if (asks.some(a => !Number.isFinite(a.price) || !Number.isFinite(a.size)
      || a.price <= 0 || a.price >= 1 || a.size < 0)) return { state: 'unavailable' };
  let remaining = budget, shares = 0;
  for (const a of asks.sort((a, b) => a.price - b.price)) {
    if (a.price > Math.min(.9999, entryPrice + tolerance) + 1e-9) break;
    const take = Math.min(a.size, remaining / a.price);
    shares += take; remaining -= take * a.price;
    if (remaining < 1e-8) return { state: 'available', average_price: budget / shares };
  }
  return { state: 'unavailable_price', filled_usd: budget - remaining };
}

export function followabilitySummary(samples, wallet) {
  const rows = samples.filter(s => s.wallet === wallet);
  const measured = rows.filter(s => s.state === 'available' || s.state === 'unavailable_price');
  const available = measured.filter(s => s.state === 'available').length;
  return { measured: measured.length, available, failed: rows.length - measured.length,
    score: measured.length >= 10 ? Math.round(100 * available / measured.length) : null };
}

export function observedChanges(previous, open, closed, at) {
  if (!previous || at <= previous.at) return [];
  const key = p => JSON.stringify([p.wallet,p.condition,p.outcome]);
  const current = new Map(open.map(p=>[key(p),p]));
  const exits = new Map(closed.map(p=>[key(p),p]));
  return previous.open.flatMap(p => {
    if (!p.condition || !p.outcome || !Number.isFinite(p.size) || p.size<=0) return [];
    const next=current.get(key(p)), exit=exits.get(key(p));
    let delta,kind;
    if(next && Number.isFinite(next.size) && next.size>0) {
      delta=next.size-p.size;
      if(Math.abs(delta)<1e-6)return [];
      kind=delta>0?'added':'reduced';
    } else if(!next && exit && exit.last_event_at>=previous.at && exit.last_event_at<=at) {
      delta=-p.size;kind='exited';
    } else return [];
    return [{...p,kind,delta_shares:delta,since:previous.at,observed_at:at,source:'browser API'}];
  });
}

export function initResearch({ state, displayName, money, ago, watchButton, isWatched, refresh, showWhale, snapshotJSON, relayURL }) {
  const $ = s => document.querySelector(s);
  const node = (tag, cls, text) => {
    const n = document.createElement(tag); if (cls) n.className = cls;
    if (text != null) n.textContent = text; return n;
  };
  const labels = {weather:'Weather',politics:'Politics',crypto:'Crypto',sports:'Sports',
    csgo:'CS:GO',valorant:'Valorant',esports:'Other esports',macro:'Macro',other:'Other'};
  let samples = [], pending = new Set(), lastSample = new Map(), loading = false;
  const observations = new Map();
  let liveEvents=[];
  function observePositions(wallet,open,closed,at) {
    const seconds=at/1000;
    liveEvents=[...observedChanges(observations.get(wallet),open,closed,seconds),...liveEvents]
      .filter(e=>seconds-e.observed_at<86400).slice(0,1000);
    observations.set(wallet,{open,at:seconds});
    if(state.view==='research')render();
  }
  try {
    const saved = JSON.parse(localStorage.getItem('whaleFollowability.v1') || '[]');
    if (Array.isArray(saved)) samples = saved.filter(s => s && typeof s.wallet === 'string'
      && ['available','unavailable_price','unavailable'].includes(s.state)
      && Number.isFinite(s.at) && Date.now()-s.at < 90*86400_000).slice(-2000);
  } catch {}
  const span = seconds => seconds == null ? 'Not measured' : seconds < 3600
    ? `${Math.round(seconds/60)} min` : seconds < 86400 ? `${(seconds/3600).toFixed(1)} h`
    : `${(seconds/86400).toFixed(1)} days`;
  const visible = wallet => !state.watchOnly || isWatched(wallet);
  function card(wallet) {
    const c = state.byWallet.get(wallet) || {wallet};
    const li = node('li', 'research-card');
    const who = node('div', 'who');
    const name = node('button', 'nm linkish', displayName(c.name, wallet));
    name.addEventListener('click', () => { if (state.byWallet.has(wallet)) showWhale(c); });
    who.append(name, watchButton(c)); li.append(who);
    return li;
  }
  function render() {
    const data = state.insights;
    $('#research-status').textContent = data
      ? `Topic scores calculated ${ago(data.generated_at)} ago · ${data.coverage?.wallets_requested ?? 0} screened whales requested · ${data.coverage?.closed_failed ?? 0} closed-history requests failed. Trade-feed activity does not update these scores.`
      : 'Waiting for the first research snapshot. Watchlists and live followability sampling are available now.';
    const topic = $('#research-topic').value;
    const qualifiedOnly = $('#research-qualified').checked;
    const rows = Object.entries(data?.profiles || {}).flatMap(([wallet,p]) =>
      (p.topics || []).filter(t => t.category === topic && (!qualifiedOnly || t.qualified))
        .map(t => ({wallet, ...t, capped:p.capped}))
    ).filter(r => visible(r.wallet)).sort((a,b) => Number(b.qualified)-Number(a.qualified) || b.pnl-a.pnl);
    const list = $('#topic-board'); list.replaceChildren();
    for (const r of rows.slice(0,100)) {
      const li = card(r.wallet);
      if (r.specialist) li.append(node('span','tag',`${labels[r.category] || r.category} specialist · sampled`));
      li.append(node('div',`headline-num ${r.pnl > 0 ? 'pos':'neg'}`,money(r.pnl)),
        node('div','tiny',`${r.markets} settled markets · ${r.wins} profitable · ${r.positive_months}/${r.months} months positive`),
        node('p','tiny',`Sample return on cost: ${r.roi == null ? 'unavailable' : (r.roi*100).toFixed(1)+'%'} · ${r.capped ? 'latest 200 settled positions' : 'all settled positions'} · ${r.qualified ? 'consistency screen passed' : 'limited / unqualified evidence'}`));
      list.append(li);
    }
    if (!rows.length) list.append(node('li','empty',state.watchOnly && !state.watchlist.size
      ? 'Your watchlist is empty. Use “Show all screened whales” above.'
      : 'No whales meet these filters yet. Turn off the consistency screen to inspect limited samples.'));
    const changes = $('#conviction-feed'); changes.replaceChildren();
    const events = [...liveEvents,...(data?.events || [])].filter(e => visible(e.wallet))
      .sort((a,b)=>b.observed_at-a.observed_at);
    $('#conviction-status').textContent=`${observations.size} whales checked in this browser session · ${liveEvents.length} observed changes. Live checks run only while Research or Holdings is open; failures back off.`;
    for (const e of events.slice(0,60)) {
      const li = card(e.wallet);
      li.append(node('span',`tag ${e.kind === 'added' ? 'pos':'neg'}`,
        e.kind === 'exited' ? 'Full exit confirmed' : e.kind === 'added' ? 'Net shares added' : 'Net shares reduced'),
      node('p','research-title',`${e.title} · ${e.outcome}`),
      node('p','tiny',`${e.source || 'Saved pipeline'} · ${Math.abs(e.delta_shares).toLocaleString()} shares · observed ${ago(e.observed_at)} ago · comparison spans ${span(e.observed_at-e.since)}`));
      changes.append(li);
    }
    if (!events.length) changes.append(node('li','empty','No observed changes yet. Each whale needs two successful observations with a quantity change or a confirmed later closure; missing rows are never treated as exits.'));
    const profiles = $('#whale-profiles'); profiles.replaceChildren();
    const wallets = new Set([...state.watchlist, ...Object.keys(data?.holdings || {})]);
    const chosen = [...wallets].filter(visible).sort((a,b)=>Number(isWatched(b))-Number(isWatched(a)) || a.localeCompare(b));
    for (const wallet of chosen.slice(0,100)) {
      const h = data?.holdings?.[wallet], f = followabilitySummary(samples,wallet);
      const li = card(wallet);
      li.append(node('p',null,`Followability: ${f.score == null ? 'Collecting evidence' : f.score+'/100'}`),
        node('p','tiny',`${f.available}/${f.measured} measured entries available after 1 min · ${f.failed} checks unavailable`),
        node('p',null,`Holding profile: ${h?.completed_samples ? 'median observation span '+span(h.median_observed_seconds) : 'building history'}`),
        node('p','tiny',`${h?.completed_samples || 0} observed open-to-close spans · ${h?.longest_current_seconds == null ? 'no current holding observation' : 'oldest currently observed position '+span(h.longest_current_seconds)}`),
        node('p','tiny','Quick trader vs settlement holder: not established. First observation is not entry time; CLOSED does not identify the exit reason.'));
      profiles.append(li);
    }
    if (!chosen.length) profiles.append(node('li','empty','Follow whales from the board to build your personal profiles.'));
    $('#followability-status').textContent = `${pending.size} live samples pending · ${samples.length} saved checks in this browser`;
  }
  async function load() {
    if (loading) return; loading = true;
    try {
      const data = await snapshotJSON('data/whale_insights.json');
      if (!data) return;
      if (!data || !Number.isFinite(data.generated_at) || !data.profiles || !Array.isArray(data.events)) throw new Error('Invalid research snapshot');
      state.insights = data; refresh(); render();
    } catch { render(); } finally { loading = false; }
  }
  function observeTrade(t) {
    const now = Date.now();
    if (!t.live || t.side !== 'BUY' || !isWatched(t.wallet) || !t.asset
        || t.price <= 0 || t.price >= 1 || now-t.ts*1000 > 30_000 || t.ts*1000 > now+5000
        || pending.size >= 8 || now-(lastSample.get(t.wallet)||0) < 300_000) return;
    const key = `${t.wallet}|${t.asset}|${now}`;
    lastSample.set(t.wallet,now); pending.add(key); render();
    setTimeout(async () => {
      let result = {state:'unavailable'};
      try {
        // Background tab throttling cannot masquerade as a one-minute observation.
        if (Date.now()-now > 75_000) throw new Error('Delayed timer');
        const relay=relayURL();
        const r = await fetch(`${relay ? relay+'/api/clob' : 'https://clob.polymarket.com'}/book?token_id=${encodeURIComponent(t.asset)}`,
          {cache:'no-store', signal:AbortSignal.timeout(10_000)});
        if (!r.ok) throw new Error('Book unavailable');
        result = assessBook(await r.json(), t.price);
        if (Date.now()-now > 75_000) result = {state:'unavailable'};
      } catch {}
      samples.push({wallet:t.wallet,at:Date.now(),entry:t.price,condition:t.condition,...result});
      samples = samples.filter(s => Date.now()-s.at < 90*86400_000).slice(-2000);
      try { localStorage.setItem('whaleFollowability.v1',JSON.stringify(samples)); } catch {}
      pending.delete(key); render();
    },60_000);
  }
  $('#research-topic').addEventListener('change',render);
  $('#research-qualified').addEventListener('change',render);
  load(); setInterval(() => {if(!document.hidden && state.view==='research')load();},1000);
  return {render,observeTrade,observePositions};
}
