const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../docs/research.js'), 'utf8');
const moduleReady = import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const book = asks => ({asks, timestamp:String(Date.now())});

test('live inventory comparisons do not invent entries or exits from missing rows',async()=>{
  const {observedChanges}=await moduleReady;
  const p={wallet:'a',condition:'c',outcome:'Yes',size:10};
  const prior={at:100,open:[p]};
  assert.equal(observedChanges(null,[p],[],110).length,0);
  assert.equal(observedChanges(prior,[],[],110).length,0);
  assert.equal(observedChanges(prior,[],[{...p,last_event_at:99}],110).length,0);
  assert.equal(observedChanges(prior,[],[{...p,outcome:'No',last_event_at:105}],110).length,0);
  assert.equal(observedChanges(prior,[{...p,size:12}],[],110)[0].delta_shares,2);
  assert.equal(observedChanges(prior,[{...p,size:8}],[],110)[0].kind,'reduced');
  assert.equal(observedChanges(prior,[],[{...p,last_event_at:105}],110)[0].kind,'exited');
  assert.equal(observedChanges(prior,[p],[{...p,last_event_at:105}],110).length,0);
});

test('followability requires enough executable depth within the price limit', async () => {
  const {assessBook} = await moduleReady;
  assert.equal(assessBook(book([{price:'.51',size:'100'}]),.5).state,'available');
  assert.equal(assessBook(book([{price:'.51',size:'1'}]),.5).state,'unavailable_price');
  assert.equal(assessBook(book([{price:'.53',size:'100'}]),.5).state,'unavailable_price');
});
test('unsorted asks are processed best-price first and boundary is inclusive', async () => {
  const {assessBook} = await moduleReady;
  const r = assessBook(book([{price:'.52',size:'100'}, {price:'.50',size:'10'}]),.5);
  assert.equal(r.state,'available');
  assert.ok(r.average_price < .52);
});
test('stale and malformed books are unmeasured, not negative samples', async () => {
  const {assessBook} = await moduleReady;
  assert.equal(assessBook({asks:[],timestamp:Date.now()-60000},.5).state,'unavailable');
  assert.equal(assessBook(book([{price:'bad',size:'100'}]),.5).state,'unavailable');
  assert.equal(assessBook({},.5).state,'unavailable');
  assert.equal(assessBook(book([]),.5).state,'unavailable_price');
});
test('score requires ten measurements and excludes failed requests', async () => {
  const {followabilitySummary} = await moduleReady;
  const rows = Array.from({length:9},()=>({wallet:'a',state:'available'}));
  rows.push({wallet:'a',state:'unavailable'});
  assert.equal(followabilitySummary(rows,'a').score,null);
  rows.push({wallet:'a',state:'unavailable_price'});
  const f = followabilitySummary(rows,'a');
  assert.equal(f.score,90); assert.equal(f.failed,1); assert.equal(f.measured,10);
  assert.equal(followabilitySummary(rows,'b').score,null);
});
