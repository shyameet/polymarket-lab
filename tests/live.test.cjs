const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../docs/live.js'),'utf8');
const ready=import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('UTC buckets roll over at month/year boundaries',async()=>{
  const {bucketBounds}=await ready;
  const b=bucketBounds(new Date('2026-12-31T23:30:00Z'));
  assert.equal(b.today.toISOString(),'2027-01-01T00:00:00.000Z');
  assert.equal(b.month.toISOString(),'2027-01-01T00:00:00.000Z');
  assert.equal(b.year.toISOString(),'2027-01-01T00:00:00.000Z');
  assert.equal(b.hours.toISOString(),'2027-01-01T03:30:00.000Z');
});
test('market refresh removes expired, closed and nontradable markets',async()=>{
  const {normalizeMarkets}=await ready;
  const lo=Date.parse('2026-09-21T00:00:00Z'),hi=lo+4*3600_000;
  const m={conditionId:'a',acceptingOrders:true,endDate:'2026-09-21T01:00:00Z',outcomes:'["Yes","No"]',outcomePrices:'["0.4","0.6"]'};
  const rows=normalizeMarkets({markets:[m,{...m,closed:true},{...m,acceptingOrders:false},
    {...m,endDate:'2026-09-20T23:00:00Z'},{...m,endDate:'2026-09-21T05:00:00Z'}]},lo,hi);
  assert.equal(rows.length,1);assert.deepEqual(rows[0].prices,[.4,.6]);
  assert.throws(()=>normalizeMarkets({error:'down'},lo,hi));
});
test('API routing uses configured relay and a unique cache nonce',async()=>{
  const {apiURL}=await ready;
  const a=new URL(apiURL('data','/v2/positions',{user:'0xabc'},'',123));
  const b=new URL(apiURL('data','/v2/positions',{user:'0xabc'},'https://relay.example/',124));
  assert.equal(a.hostname,'data-api.polymarket.com');
  assert.equal(a.searchParams.get('_'),'123');
  assert.equal(b.pathname,'/api/data/v2/positions');
  assert.equal(b.searchParams.get('_'),'124');
});
test('old saved snapshots cannot overwrite fresher per-wallet API data',async()=>{
  const {mergePositionSnapshot}=await ready;
  const current={open:[{wallet:'a',size:20}],recently_closed:[]};
  const saved={generated_at:100,open:[{wallet:'a',size:1},{wallet:'b',size:3}],recently_closed:[]};
  const result=mergePositionSnapshot(current,saved,{a:{at:200000}});
  assert.equal(result.open.find(p=>p.wallet==='a').size,20);
  assert.equal(result.open.find(p=>p.wallet==='b').size,3);
  // Empty successful API results also supersede old positions for that wallet.
  const empty=mergePositionSnapshot({open:[],recently_closed:[]},saved,{a:{at:200000}});
  assert.equal(empty.open.some(p=>p.wallet==='a'),false);
});
test('positions retain exact condition/outcome and zero prices',async()=>{
  const {normalizePosition}=await ready;
  const p=normalizePosition({condition_id:'cid',outcome:'No',current_price:0,current_size:20,
    total_size:30,avg_price:.4,last_event_at:5},{wallet:'a'},'OPEN',123,()=> 'crypto');
  assert.equal(p.condition,'cid');assert.equal(p.outcome,'No');
  assert.equal(p.current_price,0);assert.equal(p.cost_usd,12);assert.equal(p._receivedAt,123);
});
test('refresh ticks never overlap market requests',async()=>{
  const {initLive}=await ready;
  const oldFetch=global.fetch,oldDocument=global.document;
  let release,calls=0;
  const pending=new Promise(r=>{release=r;});
  global.document={hidden:false,querySelector:()=>null};
  global.fetch=async()=>{calls++;await pending;return {ok:true,json:async()=>({markets:[]})};};
  try{
    const state={view:'soon',marketsBucket:'hours',whales:[],positions:{open:[],recently_closed:[]}};
    const live=initLive({state,relayURL:()=>'',categorize:()=>'',renderPositions(){},renderMarkets(){},checkCopies(){}});
    live.tick();live.tick();assert.equal(calls,1);
    release();await new Promise(r=>setImmediate(r));
    assert.ok(live.marketChecks.hours.at);
  }finally{global.fetch=oldFetch;global.document=oldDocument;}
});
// CLOSED positions default to realized-PnL descending: an unsorted page is the
// whale's biggest winners, which hid nearly every losing exit.
test('closed-position requests ask newest-first, open requests keep the default',async()=>{
  const {initLive}=await ready;
  const oldFetch=global.fetch,oldDocument=global.document;
  const urls=[];
  global.document={hidden:false,querySelector:()=>null};
  global.fetch=async(u)=>{urls.push(new URL(u));return {ok:true,json:async()=>({data:[]})};};
  try{
    const state={view:'positions',whales:[{wallet:'0xabc',verdict:'CANDIDATE'}],
      positions:{open:[],recently_closed:[]},watchlist:new Set()};
    initLive({state,relayURL:()=>'',categorize:()=>'',renderPositions(){},renderMarkets(){},checkCopies(){}}).tick();
    await new Promise(r=>setImmediate(r));
    const closed=urls.find(u=>u.searchParams.get('status')==='CLOSED');
    const open=urls.find(u=>u.searchParams.get('status')==='OPEN');
    assert.equal(closed.searchParams.get('sort_by'),'TIMESTAMP');
    assert.equal(closed.searchParams.get('sort_direction'),'DESC');
    assert.equal(open.searchParams.get('sort_by'),null);
  }finally{global.fetch=oldFetch;global.document=oldDocument;}
});
