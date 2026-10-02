// External 15-minute timer for the paper funds (.github/workflows/fund.yml).
// GitHub's own schedule fires every few hours at best; this one fires on time.
// It only dispatches; the replay itself runs in GitHub Actions. No public
// dispatch endpoint.
const ROOT='https://api.github.com/repos/shyameet/polymarket-lab/actions/workflows/fund.yml';
export async function refresh(env, request=fetch) {
  if(!env.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN secret is required');
  const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,
    Accept:'application/vnd.github+json','User-Agent':'whale-lab-fund-timer',
    'X-GitHub-Api-Version':'2022-11-28'};
  // Do not stack a second replay behind one that is still running.
  for(const status of ['queued','in_progress','waiting','requested','pending']) {
    const r=await request(`${ROOT}/runs?branch=main&status=${status}&per_page=1`,
      {headers,signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`GitHub run lookup HTTP ${r.status}`);
    const data=await r.json();
    if(!Array.isArray(data.workflow_runs))throw new Error('Invalid GitHub run response');
    if(data.workflow_runs.length)return 'skipped: paper funds already running';
  }
  const r=await request(`${ROOT}/dispatches`,{method:'POST',
    headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({ref:'main'}),
    signal:AbortSignal.timeout(15000)});
  if(r.status!==204)throw new Error(`GitHub dispatch HTTP ${r.status}`);
  return 'paper funds dispatched';
}
export default {
  async scheduled(controller,env) { console.log(await refresh(env)); },
  fetch() {return new Response('Not found',{status:404});}
};
