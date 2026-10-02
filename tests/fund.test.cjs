const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../docs/fund.js'),'utf8');
const ready=import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

// 2026-09-23 00:00 IST = 2026-09-22 18:30 UTC -- the same instant test_fund.py uses
const MIDNIGHT=1790101800;

test('India midnight is found from any moment of the day',async()=>{
  const {istMidnight}=await ready;
  assert.equal(istMidnight(MIDNIGHT),MIDNIGHT);
  assert.equal(istMidnight(MIDNIGHT+86399),MIDNIGHT);
  assert.equal(istMidnight(MIDNIGHT-1),MIDNIGHT-86400);
});

test('change since a moment reads from the last reading at or before it',async()=>{
  const {changeSince}=await ready;
  const pts=[[100,1000],[200,1010],[300,990],[400,1004]];
  assert.equal(changeSince(pts,250),1004-1010);
  assert.equal(changeSince(pts,300),1004-990);
  assert.equal(changeSince(pts,50),4);            // younger than the window: since the start
  assert.equal(changeSince([],50),null);
});

const C1='0x'+'a'.repeat(64), C2='0x'+'b'.repeat(64);
const W1='0x'+'1'.repeat(40), W2='0x'+'2'.repeat(40);
const T=MIDNIGHT+3600;
const fill=(ts,side,size,price,o={})=>({type:'TRADE',timestamp:ts,side,size,price,usdcSize:size*price,
  asset:'T1',conditionId:C1,outcome:'Yes',title:'Will it?',slug:'will-it',wallet:W1,name:'one',...o});

test('the preview flags the fill that takes a whale to $100, at its time and price',async()=>{
  const {pendingMoves}=await ready;
  const {signals,sells}=pendingMoves([fill(T+5,'BUY',150,.4),fill(T+9,'BUY',100,.42),fill(T+30,'BUY',500,.5)],T);
  assert.equal(signals.length,1);
  assert.deepEqual([signals[0].ts,signals[0].price,signals[0].usd],[T+9,.42,102]);
  assert.deepEqual(sells,[]);
});

test('the preview counts only fills after the last update, per India day',async()=>{
  const {pendingMoves}=await ready;
  assert.equal(pendingMoves([fill(T,'BUY',300,.5)],T).signals.length,0);              // at the cursor: already booked
  assert.equal(pendingMoves([fill(MIDNIGHT-10,'BUY',120,.5),fill(MIDNIGHT+10,'BUY',120,.5)],MIDNIGHT-100)
    .signals.length,0);                                                                // $60 + $60 on two days
});

test('the preview copies the first whale on an outcome and skips parlays and dust',async()=>{
  const {pendingMoves}=await ready;
  const {signals}=pendingMoves([
    fill(T+5,'BUY',300,.5,{wallet:W2,name:'two'}),fill(T+9,'BUY',300,.5),
    fill(T+5,'BUY',900,.5,{asset:'P',conditionId:'0xshort'}),
    fill(T+5,'BUY',500,.9995,{asset:'T2'})],T);
  assert.deepEqual(signals.map(s=>[s.wallet,s.others]),[[W2,1]]);
});

test('the preview says which funds already hold an outcome, and which follow a sale',async()=>{
  const {pendingMoves}=await ready;
  const held=new Map([['T1',new Set(['A'])]]);
  const copying=new Map([[`${W1}|T9`,new Set(['B','A'])]]);
  const {signals,sells}=pendingMoves([fill(T+5,'BUY',300,.5),fill(T+6,'SELL',50,.7,{asset:'T9'}),
    fill(T+7,'SELL',50,.7,{asset:'T8'})],T,held,copying);
  assert.deepEqual(signals[0].held,['A']);
  assert.deepEqual(sells.map(s=>[s.token,s.funds,s.price]),[['T9',['A','B'],.7]]);
});

test('relay URLs carry the params once and a cache-busting nonce',async()=>{
  const {relayURLFor}=await ready;
  const u=new URL(relayURLFor('https://relay.example/','data','/activity',{user:W1,start:5},42));
  assert.equal(u.pathname,'/api/data/activity');
  assert.deepEqual([u.searchParams.get('user'),u.searchParams.get('start'),u.searchParams.get('_')],[W1,'5','42']);
});

test('days roll up into Monday-first weeks, each week changed from the last',async()=>{
  const {weeks}=await ready;
  const days=[                                   // newest first, as fund.json writes them
    {date:'2026-10-06',copied:3,closed:2,won:1,realized:-4,equity:1003,change:-5},
    {date:'2026-10-04',copied:5,closed:4,won:3,realized:6,equity:1008,change:2},
    {date:'2026-10-02',copied:7,missed:2,closed:1,won:1,realized:1,equity:1006,change:6}];
  const w=weeks(days,1000);
  assert.deepEqual(w.map(x=>x.week),['2026-10-05','2026-09-28']);
  assert.deepEqual([w[1].copied,w[1].missed,w[1].closed,w[1].won,w[1].realized],[12,2,5,4,7]);
  assert.equal(w[1].equity,1008);
  assert.equal(w[1].change,8);
  assert.equal(w[0].change,-5);
});
