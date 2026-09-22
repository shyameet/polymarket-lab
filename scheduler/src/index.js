// External timer for the existing Python pipeline. No public dispatch endpoint.
const ROOT='https://api.github.com/repos/shyameet/polymarket-lab/actions/workflows/refresh.yml';
export async function refresh(env, request=fetch) {
  if(!env.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN secret is required');
  const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,
    Accept:'application/vnd.github+json','User-Agent':'whale-lab-refresh',
    'X-GitHub-Api-Version':'2022-11-28'};
  // Do not cancel a still-running build with another dispatch.
  for(const status of ['queued','in_progress','waiting','requested','pending']) {
    const r=await request(`${ROOT}/runs?branch=main&status=${status}&per_page=1`,
      {headers,signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`GitHub run lookup HTTP ${r.status}`);
    const data=await r.json();
    if(!Array.isArray(data.workflow_runs))throw new Error('Invalid GitHub run response');
    if(data.workflow_runs.length)return 'skipped: pipeline already active';
  }
  const r=await request(`${ROOT}/dispatches`,{method:'POST',
    headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({ref:'main'}),
    signal:AbortSignal.timeout(15000)});
  if(r.status!==204)throw new Error(`GitHub dispatch HTTP ${r.status}`);
  return 'pipeline dispatched';
}
export default {
  async scheduled(controller,env) { console.log(await refresh(env)); },
  fetch() {return new Response('Not found',{status:404});}
};
