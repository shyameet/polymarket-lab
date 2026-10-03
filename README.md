# Polymarket Whale Lab

A live Polymarket trade tape plus a **copy-trade screen** that ranks wallets by
drawdown rather than profit.

It is a static site. There is no server, no database, no API key, and **no
execution code** — nothing here can place a trade.

---

## Why it doesn't just show a leaderboard

Because a leaderboard is a sorted in-sample pool, and rank on it carries no
forward information. It selects for whoever took the biggest bet and won, which
is not a repeatable property.

Two wallets from the real data:

| Wallet | The headline | What the screen sees |
|---|---|---|
| **Theo4** | #1 all-time, **$22.05M** | **38%** of it from one position · **4 of 23** months positive · **$5.39M** peak-to-trough · dormant since Feb 2026 |
| **RN1** | $12.5M over **4.7M fills**, **100%** positive months | **39%** of profit is rebates/rewards · **2.1%** edge per dollar → a market maker. You cannot follow someone into a quote. |

Neither is copyable, and a profit sort puts both on top.

Meanwhile the best risk-adjusted wallet in the current build — **Net/DD 33.4,
89% positive months, 23,915 fills, 5% concentration** — appears on **no
leaderboard at all**, because it "only" made $151k. It was found by walking the
top holders of liquid markets instead.

## What it scores

| Metric | Question it answers |
|---|---|
| **Net / MaxDD** | Profit per dollar of peak-to-trough pain. Scale-invariant. |
| **Concentration** | Is the record one bet, or a process? |
| **Program income share** | How much of the "profit" is rebates and liquidity rewards — money a copier cannot inherit? |
| **Edge per dollar traded** | >20% = concentrated directional bettor. <3% on huge volume = spread grinder. Copyable edge is in between. |
| **% positive months** | The cheapest separator between an edge and a jackpot. |

Verdicts: `CANDIDATE` · `WATCH` · `FRAGILE` · `NOT COPYABLE` · `INSUFFICIENT`.
The default assumption is **not copyable**; a wallet has to earn its way out.

## Two traps this is hardened against

**The equity curve doesn't start at zero.** One live wallet's series *opens* at
−$176,289. Seeding the high-water mark at the first observation treats "already
six figures down" as the peak, erasing the inception drawdown and reporting a
riskless-looking `MaxDD = $0`.

**Some curves are fake.** The API sometimes back-fills a flat line — one
wallet's 93-point history was a *single value repeated 93 times*. Zero variance
⇒ zero drawdown ⇒ **infinite Net/DD**, which sorts straight to the top of a
risk-first ranking. Wallets whose curve moves fewer than 10 times are marked
`INSUFFICIENT` and refused a rank. Without that gate, the top of the board was
four wallets whose drawdown was simply *unmeasured*.

---

## How it runs

```
GitHub Actions (hourly)          GitHub Pages (static)          Browser
  pipeline/pm/build.py    ──►    docs/data/*.json       ──►     renders board
  ~3 API calls per wallet        committed to the repo          + opens its own
                                                                websocket for
                                                                the live tape
```

Polymarket's read APIs all return `access-control-allow-origin: *`, so the page
talks to them directly — no proxy needed. **REST is not live**: every REST
response is CDN-cached `max-age=300`, so it can be 5 minutes stale. Only
`wss://ws-live-data.polymarket.com` is real time (~43 fills/sec, unauthenticated,
global — no per-market subscription).

### Daily recap (`pipeline/pm/daily.py` → `docs/data/daily/`)

One file per India-time day of what the **Worth following** whales did: every
entry of $100+ (all buys of one outcome that day, at their average price), whether
they sold it, whether it settled won or lost, and what a $100 copy would have made
after taker fees. Each run rewrites today and the two days before, because outcomes
keep arriving after a day ends; older days stay as written. `index.json` feeds the
calendar. Every win rate is shown beside its **price baseline** (a no-skill buyer
who pays 80¢ wins ~80% of the time), because a high win rate on favourites is not
skill. The Recap tab also pulls trades made since the last run, live, through the
relay. Market state comes from the CLOB, one condition per request, because it
carries each token's price and winner flag. A trap found building it, verified
2026-09-23: combos/parlays carry a synthetic 64-character condition id with no CLOB
market behind it.

### Paper funds (`pipeline/pm/fund.py` → `docs/data/fund/`)

Two $1,000 paper accounts that copy the **Worth following** whales by fixed rules,
opened empty on 2026-10-02 with no backfill. A signal is a whale's buys of one
outcome on one India-time day reaching $100; the fund buys a flat **$10** at that
fill's price, in the same second. It then follows the whale it copied: a sale of
part of what the whale bought sells the same share at the same price, otherwise it
holds and is paid $1 / $0 when the market settles. One position per outcome; a
signal that finds no cash is counted as missed. Fund A copies every signal, fund B
only markets scheduled to end within 48 hours, and fund C (added 2026-10-03) every
signal except crypto and esports markets (`feed.categorize` topics crypto, csgo,
valorant, esports). Taker fees on every buy and sell. A fund added later opens
empty at the first run that knows it and copies only signals after that moment; it
shares nothing with the others but the signal, and a test checks that A and B come
out identical with or without it. C's topics were chosen after one day of A's
results, so only C's own record from its opening tests the idea.

Each run replays the whales' fills since the last run in time order, using the
whale list saved by the previous run (no look-ahead), with settlements as events in
the same timeline, at the moment each market closed, so the cash is back for the
next signal. A market pays out only once the replay has passed its close, so a sale
minutes before the end is followed, not held to $1 / $0. `state.json` carries the
book between runs; `fund.json` is what the page reads. Every copy is also scored a
minute late (CLOB price history at +60 s): in 5-minute "Up or Down" markets that
minute moves the price by up to 30¢, and the per-topic table shows it.

The funds run in their own job, `.github/workflows/fund.yml` (about a minute: read
the whale trades since the last run, replay, commit `docs/data/fund` only), and it
paces itself every ~15 minutes with no outside timer or stored token: each run ends
by queuing the next one with the built-in `GITHUB_TOKEN` (allowed for
`workflow_dispatch`), and a queued run first waits out the 14-minute wait timer of
the `fund-timer` environment, which holds no runner. Only one successor is ever
queued; GitHub's own schedule (every few hours in practice) restarts the chain if an
outage breaks it. The full rebuild runs with `--no-fund`, so the two jobs never write
the same files, and it stays on GitHub's schedule: rebuilding everything every 15
minutes would add 1-2 GB of git history a month. Between updates the page's "Being
copied right now" strip reads the whale trades since the last update through the
relay and applies the same rules, as a preview.

Two traps found building it, verified 2026-10-02: settling only at the end of a run
starved fund A of cash it would have had back hours earlier (198 signals "missed"
in a 6-hour replay, 140 once payouts were timed); and eight unpaced threads drew
HTTP 429 from the CLOB, which would have left markets undated and silently skipped
by fund B. Lookups are now paced (CLOB 10/s, Gamma 5/s) and a 429 is waited out.

### Run locally

```bash
cd pipeline
python -m pm.build --top 40 --out ../docs/data     # ~70s for ~280 wallets
python -m http.server 8765 --directory ../docs
```

Flags: `--no-discover` (skip the holder scan), `--limit N` (cap wallets),
`--workers N`.

### Deploy

Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder
`/docs`. The hourly workflow commits fresh data to the same branch.

---

## API notes worth keeping

Everything below was verified live against production, not read from the docs.

- **Unknown query params are silently ignored with a 200.** Sending `window=all`
  to `/v2/leaderboard` (the real param is `time_period`) returns normal-looking
  data for the *default* window. `api.py` whitelists params and raises locally.
- `/v2/trades` defaults to `taker_only=true` and **silently drops maker fills**.
- Gamma silently clamps `limit` to 100 and silently **ignores `active=`** — it is
  not a tradability flag. Use `acceptingOrders`.
- Gamma `/markets` and `/events` are deprecated (`sunset: 2026-05-01`, already
  past). Use `/markets/keyset`. It takes `condition_ids` as a **repeated** param
  and returns every match in one call, up to its 100-row page (a comma-joined
  value matches nothing).
- **Our relay keeps only the LAST value of a repeated query param**
  (`worker/src/index.js` copies the query with `searchParams.set`). Through it,
  `/markets/keyset` looks like it returns ONE market however many `condition_ids`
  are sent; called directly it returns them all. Test repeated-param queries
  against the API itself, not the relay.
- `/v2/user-pnl` defaults to 1h fidelity → ~10MB per active wallet. Pass
  `fidelity=1d` (~450KB).
- `entry_cost_usdc` is the basis of what is **still held** and collapses to 0 on
  closed positions. Lifetime cost is `total_size * avg_price`.
- Leaderboard `volume` is in **shares**, not USDC. Use `volume_usdc`.
- `time_period=day|week|month` are **mark-inclusive**; `all` is realized-only.
  They are different quantities and must not be compared.
- ~6% of websocket trade messages arrive with `conditionId`/`title`/`slug`/
  `outcome` blank together. `asset` is always present.

## Scope and limits

Research on public data. It places no trades, holds no keys, and gives no
advice. A high rank means "worth forward-testing", not "worth money" — the
honest next step is to paper-track a shortlist forward and check whether rank
survives out of sample.

**Access note.** Polymarket is blocked in India under a MeitY s69A order
(~22 May 2026), following the Promotion and Regulation of Online Gaming Act 2025,
which classes prediction markets as prohibited online money games. The read-only
APIs used here still resolve; the trading site does not.
