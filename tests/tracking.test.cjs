const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Execute the actual app definitions, without browser event wiring or boot.
const source = fs.readFileSync(path.join(__dirname, '../docs/app.js'), 'utf8');
const definitions = source.slice(0, source.lastIndexOf('/*', source.indexOf('const VIEWS =')));
function app(fetch = async () => { throw new Error('offline'); }) {
  const ctx = vm.createContext({ console, Date, URL, URLSearchParams, AbortController, AbortSignal,
    location: {search:''},
    setTimeout, clearTimeout, fetch, document: { querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(definitions, ctx);
  return { run: (code) => vm.runInContext(code, ctx), ctx };
}
const setup = `const c = { wallet: '0x123', condition: 'condition-a', outcome: 'Yes',
  key: posKey('0x123', '', '', 'Yes', 'condition-a'), addedAt: Math.floor(Date.now()/1000)-60 };
  state.copies = [c];`;

test('snapshot checks bypass cached URLs and skip unchanged JSON bodies', async () => {
  const calls = [];
  const a = app(async (url, options) => {
    calls.push({url,options});
    return {ok:true,headers:{get:()=> 'revision-one'},json:async()=>({generated_at:123})};
  });
  assert.equal((await a.run("snapshotJSON('data/meta.json')")).generated_at,123);
  assert.equal(await a.run("snapshotJSON('data/meta.json')"),null);
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.method,'HEAD');
  assert.ok(calls.every(c=>c.url.startsWith('data/meta.json?refresh=')));
  assert.ok(calls.every(c=>c.options.cache==='no-store'));
});

test('expired holdings and failed checks cannot show current prices', () => {
  const a = app(); a.run(setup);
  a.run(`c.live = { state: 'in', checkedAt: Date.now()-7*60_000,
    rows: [{outcome:'Yes', current_price:0.8}] };`);
  assert.equal(a.run('copyStatus(c).state'), 'stale');
  assert.equal(a.run('copyStatus(c).price'), undefined);
  a.run('c.live.checkedAt = Date.now(); c.checkFailed = true');
  assert.equal(a.run('copyStatus(c).state'), 'stale');
});
test('exit before copy creation is not a new exit alert', () => {
  const a = app(); a.run(setup);
  a.run(`c.live = { state: 'exited', checkedAt: Date.now(),
    rows: [{outcome:'Yes', last_event_at:c.addedAt-1}] };`);
  assert.equal(a.run('copyStatus(c).state'), 'unknown');
  a.run('c.live.rows[0].last_event_at = c.addedAt+1');
  assert.equal(a.run('copyStatus(c).state'), 'exited');
});
test('stale snapshots cannot confirm current holdings', () => {
  const a = app(); a.run(setup);
  a.run(`state.posMeta = { generated_at: Date.now()/1000-3600 };
    state.positions.open = [{wallet:c.wallet, condition:c.condition, outcome:c.outcome, current_price:0.9}];`);
  assert.equal(a.run('copyStatus(c).state'), 'stale');
});
test('repeated titles and ambiguous slugs never migrate to an arbitrary market', () => {
  const a = app(); a.run(setup);
  a.run(`c.condition=''; c.slug=''; c.title='Bitcoin tomorrow';
    state.trades = [{wallet:c.wallet,condition:'wrong',slug:'',title:c.title,outcome:'Yes'}]; migrateCopies();`);
  assert.equal(a.run('c.condition'), '');
  a.run(`c.slug='repeat'; state.trades = ['a','b'].map(condition =>
    ({wallet:c.wallet,condition,slug:'repeat',outcome:'Yes'})); migrateCopies();`);
  assert.equal(a.run('c.condition'), '');
});
test('HTTP errors and malformed responses are failures, not evidence of exit', async () => {
  for (const response of [{ ok:false, status:429 }, {ok:true,json:async()=>({error:'unavailable'})}]) {
    const a = app(async () => response);
    assert.equal(await a.run(`liveCopyLookup('wallet','market','Yes')`), null);
  }
});
test('opposite outcome remains separate from the tracked outcome', async () => {
  const a = app(async (url) => ({ok:true,json:async()=>({data:url.includes('status=OPEN')
    ? [{outcome:'No',current_price:0.4}] : [{outcome:'Yes',last_event_at:1780000000}]})}));
  assert.equal((await a.run(`liveCopyLookup('wallet','market','Yes')`)).state, 'exited');
});
test('parallel poll batches do not duplicate network requests', async () => {
  let resolve; let calls=0;
  const pending=new Promise(r=>{resolve=r;});
  const a=app(async()=>{calls++;await pending;return {ok:true,json:async()=>({data:[{outcome:'Yes'}]})};});
  a.run(setup);
  const first=a.run('pollAllCopies()');
  await a.run('pollAllCopies()');
  assert.equal(calls,1); resolve(); await first;
});
test('HTML payloads are escaped and invalid copy stakes are rejected', () => {
  const a=app();
  assert.equal(a.run(`escapeHTML('<img src=x onerror="attack()">')`), '&lt;img src=x onerror=&quot;attack()&quot;&gt;');
  assert.equal(a.run(`addCopy({price:0.5,stake:-25})`),false);
  assert.equal(a.run(`addCopy({price:0,stake:25})`),false);
});
