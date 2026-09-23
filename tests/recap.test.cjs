const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../docs/recap.js'),'utf8');
const ready=import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

// 2026-09-23 00:00 IST = 2026-09-22 18:30 UTC -- the same instant test_daily.py uses
const MIDNIGHT=1790101800;

test('India midnight splits the day, as the pipeline does',async()=>{
  const {istDay,istClock}=await ready;
  assert.equal(istDay(MIDNIGHT-1),'2026-09-22');
  assert.equal(istDay(MIDNIGHT),'2026-09-23');
  assert.equal(istClock(MIDNIGHT+5*3600+7*60),'05:07');
});

test('calendar is Monday-first with padding to whole weeks',async()=>{
  const {monthCells}=await ready;
  const c=monthCells('2026-09');           // 1 Sep 2026 is a Tuesday
  assert.equal(c[0],null);
  assert.equal(c[1],'2026-09-01');
  assert.equal(c.length%7,0);
  assert.equal(c.filter(Boolean).length,30);
  assert.equal(monthCells('2026-02').filter(Boolean).length,28);
});

test('summary matches the pipeline: open rows never count as won or lost',async()=>{
  const {summarise}=await ready;
  const s=summarise([
    {usd:100,status:'won',baseline:.8,copy_pnl:20},
    {usd:100,status:'lost',baseline:.6,copy_pnl:-60},
    {usd:100,status:'open',baseline:null,copy_pnl:5},
    {usd:100,status:'unknown',baseline:null,copy_pnl:null}]);
  assert.deepEqual([s.closed,s.won,s.lost,s.open,s.entries],[2,1,1,1,4]);
  assert.equal(s.win_rate,.5);
  assert.ok(Math.abs(s.baseline-.7)<1e-9);
  assert.equal(s.copy_pnl_closed,-40);
  assert.equal(s.copy_pnl_open,5);
  assert.equal(summarise([]).win_rate,null);
});

test('new trades since the last run: one row per token, $100 floor, nothing old',async()=>{
  const {newSince}=await ready;
  const f=(ts,side,size,price,asset='A',type='TRADE')=>({type,timestamp:ts,side,size,price,
    usdcSize:size*price,asset,conditionId:'0x'+'1'.repeat(64),outcome:'Yes',title:'T',slug:'t'});
  const g=newSince([
    f(99,'BUY',1000,.5),                    // before `since`: ignored
    f(101,'BUY',100,.4),f(105,'BUY',300,.6),// one entry, VWAP .55
    f(106,'BUY',50,.5,'B'),                 // $25: below the floor
    f(107,'SELL',400,.7,'C'),
    f(108,'BUY',500,.5,'D','REDEEM'),       // not a trade
  ],100);
  assert.equal(g.entries.length,1);
  assert.equal(g.entries[0].fills,2);
  assert.equal(g.entries[0].ts,101);
  assert.ok(Math.abs(g.entries[0].price-.55)<1e-9);
  assert.equal(g.exits.length,1);
  assert.equal(g.exits[0].asset,'C');
});

test('relay URLs carry a cache nonce and tolerate a trailing slash',async()=>{
  const {relayURLFor}=await ready;
  const u=new URL(relayURLFor('https://relay.example/','clob','/markets/0xabc',{},42));
  assert.equal(u.pathname,'/api/clob/markets/0xabc');
  assert.equal(u.searchParams.get('_'),'42');
  const a=new URL(relayURLFor('https://relay.example','data','/activity',{user:'0x1',start:5},1));
  assert.equal(a.searchParams.get('start'),'5');
});
