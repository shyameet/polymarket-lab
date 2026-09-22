const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../scheduler/src/index.js'),'utf8');
const ready=import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('scheduler skips an active run and never sends a dispatch',async()=>{
  const {refresh}=await ready;let calls=0;
  assert.match(await refresh({GITHUB_TOKEN:'test'},async()=>{
    calls++;return {ok:true,json:async()=>({workflow_runs:[{id:1}]})};
  }),/skipped/);assert.equal(calls,1);
});
test('scheduler dispatches main only after successful idle checks',async()=>{
  const {refresh}=await ready;let posts=0;
  await refresh({GITHUB_TOKEN:'test'},async(url,options)=>{
    if(options.method==='POST'){posts++;assert.deepEqual(JSON.parse(options.body),{ref:'main'});return {status:204};}
    return {ok:true,json:async()=>({workflow_runs:[]})};
  });assert.equal(posts,1);
});
test('scheduler refuses missing credentials or failed run lookup',async()=>{
  const {refresh}=await ready;
  await assert.rejects(refresh({},()=>{throw Error('must not call');}),/secret/);
  await assert.rejects(refresh({GITHUB_TOKEN:'test'},async()=>({ok:false,status:403})),/403/);
});
