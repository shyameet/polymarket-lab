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
relay. Traps found building it, both verified 2026-09-23: Gamma's
`/markets/keyset` with repeated `condition_ids` returns ONE market whatever the
count (so market state comes from the CLOB per condition), and combos/parlays carry
a synthetic 64-character condition id with no CLOB market behind it.

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
  past). Use `/markets/keyset`.
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
