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
