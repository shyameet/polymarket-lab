/* Direct read-only refresh for active views. Snapshot age must never be reset
 * by polling an unchanged JSON file. Poll cadence != upstream data freshness.
 * All-wallet coverage is deliberately bounded; a focused wallet refreshes on
 * every one-second tick, without overlapping requests. */
export function bucketBounds(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const sunday = (7 - now.getUTCDay()) % 7;
  return {hours:new Date(+now+4*3600_000),today:new Date(Date.UTC(y,m,d+1)),
    weekend:new Date(Date.UTC(y,m,d+sunday+1)-1),month:new Date(Date.UTC(y,m+1,1)),
    year:new Date(Date.UTC(y+1,0,1))};
}
export function apiURL(host, path, params, relay = '', now = Date.now()) {
  const bases = {data:'https://data-api.polymarket.com',gamma:'https://gamma-api.polymarket.com'};
  const base = relay ? `${relay.replace(/\/+$/,'')}/api/${host}` : bases[host];
  if (!base) throw new Error('Unknown API host');
  const u = new URL(base+path);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,String(v));
  u.searchParams.set('_',String(now)); // verified cache-key nonce, not a data-age guarantee
  return u.href;
}
const array = v => { if (Array.isArray(v)) return v; try {const a=JSON.parse(v);return Array.isArray(a)?a:[];} catch {return [];} };
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
export function normalizeMarkets(body, lo, hi) {
  const rows = Array.isArray(body) ? body : body?.markets;
  if (!Array.isArray(rows)) throw new Error('Invalid markets response');
  return rows.filter(m => m.conditionId && m.acceptingOrders === true && !m.closed
    && Date.parse(m.endDate)>lo && Date.parse(m.endDate)<=hi).map(m=>({
      condition:m.conditionId,title:m.question||'',slug:m.slug||'',end_date:m.endDate,
      volume:num(m.volumeNum),liquidity:num(m.liquidityNum),outcomes:array(m.outcomes),
      prices:array(m.outcomePrices).map(Number),neg_risk:!!m.negRisk,
    }));
}
export function normalizePosition(p,c,status,receivedAt,categorize) {
  const avg=num(p.avg_price);
  return {wallet:c.wallet,name:c.name,verdict:c.verdict,discovered:!!c.discovered,
    status,title:p.title||'',slug:p.slug||'',condition:p.condition_id||'',outcome:p.outcome||'',
    category:categorize(p.title,p.slug),avg_price:avg,current_price:num(p.current_price),
    size:num(status==='OPEN'?p.current_size:p.total_size),
    cost_usd:num(p.total_cost_usdc)||num(p.total_size)*avg||num(p.entry_cost_usdc),
    value_usd:num(p.current_value),realized_pnl:num(p.realized_pnl),unrealized_pnl:num(p.unrealized_pnl),
    total_pnl:num(p.total_pnl),last_event_at:num(p.last_event_at),redeemable:!!p.redeemable,
    likely_hedge_residue:!!p.negative_risk&&Math.abs(avg-.5)<.02,end_date:p.end_date,
    _receivedAt:receivedAt};
}
export function mergePositionSnapshot(current, incoming, checked) {
  const newer = new Set(Object.entries(checked).filter(([,v])=>v.at>incoming.generated_at*1000).map(([w])=>w));
  const merge = key => [...(incoming[key]||[]).filter(p=>!newer.has(p.wallet)),
    ...(current[key]||[]).filter(p=>newer.has(p.wallet))];
  return {open:merge('open'),recently_closed:merge('recently_closed')};
}

export function initLive({state,relayURL,categorize,renderPositions,renderMarkets,checkCopies}) {
  const walletChecks = {}, marketChecks = {};
  const busy = new Set(), retry = new Map(), failures = new Map();
  const dirtyWallets = new Set();
  let marketError = '', holdingError = '';
  async function request(key,host,path,params) {
    if (busy.has(key) || Date.now()<(retry.get(key)||0)) return null;
    busy.add(key);
    try {
      const r=await fetch(apiURL(host,path,params,relayURL()),{cache:'no-store',signal:AbortSignal.timeout(8000)});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body=await r.json();
      failures.delete(key); retry.delete(key);return body;
    } catch(e) {
      const n=(failures.get(key)||0)+1;failures.set(key,n);
      retry.set(key,Date.now()+Math.min(60_000,1000*2**n));throw e;
    } finally {busy.delete(key);}
  }
  async function markets() {
    const bucket=state.marketsBucket,key='markets:'+bucket;
    if(busy.has(key))return;
    try {
      const now=new Date(), hi=bucketBounds(now)[bucket];
      const body=await request(key,'gamma','/markets/keyset',{
        limit:40,closed:false,order:'volumeNum',ascending:false,
        end_date_min:now.toISOString(),end_date_max:hi.toISOString()});
      if(body===null)return;
      const rows=normalizeMarkets(body,+now,+hi),at=Date.now();
      state.marketsSoon ||= {buckets:{},bucket_ends:{}};
      state.marketsSoon.buckets[bucket]=rows;
      state.marketsSoon.bucket_ends[bucket]=hi.toISOString();
      marketChecks[bucket]={at,count:rows.length}; marketError='';
      if(state.view==='soon')renderMarkets();
    } catch {marketError='Live market request failed; retaining the last received data.';}
  }
  async function wallet(c) {
    const key='wallet:'+c.wallet;
    if(busy.has(key)||Date.now()<(retry.get(key)||0))return;
    busy.add(key);
    try {
      // CLOSED defaults to realized-PnL descending, so an unsorted page is the
      // whale's biggest winners and a losing exit never shows up; ask newest first.
      const [opened,closed]=await Promise.all(['OPEN','CLOSED'].map(status=>request(key+status,'data','/v2/positions',{
        user:c.wallet,status,include_pnl:true,limit:100,
        ...(status==='CLOSED'?{sort_by:'TIMESTAMP',sort_direction:'DESC'}:{})})));
      if(opened===null||closed===null)return;
      if(!Array.isArray(opened?.data)||!Array.isArray(closed?.data))throw new Error('Invalid positions');
      const at=Date.now();
      if(opened.data.some(p=>!Number.isFinite(Number(p.current_size))))throw new Error('Invalid position size');
      const open=opened.data.map(p=>normalizePosition(p,c,'OPEN',at,categorize))
        .filter(p=>Math.max(p.value_usd,p.cost_usd)>=50);
      const closedRows=closed.data.map(p=>normalizePosition(p,c,'CLOSED',at,categorize))
        .filter(p=>p.last_event_at>=at/1000-7*86400 && Math.max(p.cost_usd,Math.abs(p.realized_pnl))>=50);
      state.research?.observePositions(c.wallet,open,closedRows,at);
      state.positions.open=[...state.positions.open.filter(p=>p.wallet!==c.wallet),...open];
      state.positions.recently_closed=[...state.positions.recently_closed.filter(p=>p.wallet!==c.wallet),...closedRows];
      walletChecks[c.wallet]={at,truncated:!!(opened.pagination?.next_cursor||closed.pagination?.next_cursor)};
      failures.delete(key);retry.delete(key);dirtyWallets.delete(c.wallet);holdingError='';
      if(state.view==='positions')renderPositions();checkCopies();
    } catch {
      const n=(failures.get(key)||0)+1;failures.set(key,n);retry.set(key,Date.now()+Math.min(60_000,1000*2**n));
      holdingError='Some live holdings requests failed; older rows retain their own timestamps.';
    } finally {busy.delete(key);}
  }
  function tick() {
    if(document.hidden)return;
    if(state.view==='soon')markets();
    if(state.view==='positions' || state.view==='research') {
      const focus=state.view==='positions' ? state.holdingWallet : '';
      let cards=state.whales.filter(c=>focus?c.wallet===focus:
        (state.watchOnly?state.watchlist.has(c.wallet):['CANDIDATE','WATCH','FRAGILE'].includes(c.verdict)));
      cards.sort((a,b)=>Number(dirtyWallets.has(b.wallet))-Number(dirtyWallets.has(a.wallet))
        ||(walletChecks[a.wallet]?.at||0)-(walletChecks[b.wallet]?.at||0));
      const active=[...busy].filter(k=>k.startsWith('wallet:')&&!k.endsWith('OPEN')&&!k.endsWith('CLOSED')).length;
      cards.filter(c=>!busy.has('wallet:'+c.wallet)&&Date.now()>=(retry.get('wallet:'+c.wallet)||0))
        .slice(0,Math.max(0,4-active)).forEach(wallet);
    }
    paintStatus();
  }
  function paintStatus() {
    const market=marketChecks[state.marketsBucket];
    const age=at=>at?`${Math.max(0,Math.floor((Date.now()-at)/1000))}s ago`:'not yet received';
    const p=document.querySelector('#holdings-live-status'),m=document.querySelector('#markets-live-status');
    if(p) {
      const scope=state.holdingWallet?[state.holdingWallet]:state.whales.filter(c=>state.watchOnly?state.watchlist.has(c.wallet):['CANDIDATE','WATCH','FRAGILE'].includes(c.verdict)).map(c=>c.wallet);
      const fresh=scope.filter(w=>Date.now()-(walletChecks[w]?.at||0)<15_000).length;
      p.textContent=`1-second refresh loop · ${state.holdingWallet?'focused whale':'rotating up to 4 whales per tick'} · ${fresh}/${scope.length} whales received in the last 15s. ${holdingError} API data can lag. Each row shows its source age.`;
    }
    if(m)m.textContent=`1-second refresh loop · ${market?'API response '+age(market.at):'showing saved snapshot while connecting'}. ${marketError} Upstream prices can lag.`;
  }
  return {tick,paintStatus,walletChecks,marketChecks,
    onTrade:t=>{if(t.live && state.whales.some(c=>c.wallet===t.wallet))dirtyWallets.add(t.wallet);},
    positionSnapshot:p=>mergePositionSnapshot(state.positions,p,walletChecks),
    marketSnapshot:m=>{
      for(const [k,v] of Object.entries(marketChecks))if(v.at>m.generated_at*1000&&state.marketsSoon?.buckets[k]) {
        m.buckets[k]=state.marketsSoon.buckets[k];m.bucket_ends[k]=state.marketsSoon.bucket_ends[k];
      }
      return m;
    }};
}
