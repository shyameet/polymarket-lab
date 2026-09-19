# Whale research

The Whale research tab adds topic results, specialist screens, observed inventory
changes, followability measurements, and holding observations. Follow buttons on
the main board, research cards, and wallet drawer build a browser-local watchlist.
The global Only whales I follow filter applies to the main board, research,
trade tape, holdings, and whale annotations on closing-soon markets. It does not
hide the user's saved copies or independent crypto transfer data.

## Topic results and specialist badges

The existing position collector now requests up to 200 CLOSED positions for
each wallet that passed the overall CANDIDATE/WATCH/FRAGILE screen. Results are
aggregated by topic and condition ID, combining both outcomes into one market.
Hedge-residue rows are excluded. This is a capped sample of closed positions,
not lifetime topic equity, a rolling time window, or a measure of open losses.
The API's default selection order can bias the capped sample. Topic assignment
uses the existing title/slug classifier and is displayed as inferred.

Within each topic, rows are ranked by sampled realized PnL, with qualified rows
first. Qualification requires at least 20 markets, positive PnL, positive cost,
three represented closing months, at least 60% of those months positive, and
no market contributing over 35% of gross winning profit. A specialist badge
also requires at least 60% of sampled cost to belong to that topic. These are
transparent heuristic screens, not statistical proof of repeatable skill.

## Conviction and holding observations

`pipeline/pm/insights.py` persists state in `docs/data/whale_insights.json`.
Adjacent OPEN observations are compared by share count, not market value.
Absence from the capped snapshot never establishes an exit. Only a matching
CLOSED record after the preceding observation does. Concurrent contradictory
OPEN/CLOSED records retain the OPEN observation. Net inventory changes can
also reflect conversions/transfers and do not prove conviction or a fill.

First observation times are retained for up to 90 days. An explicit close
records the elapsed observation span. This is not a precise holding duration:
the actual entry predates observation and gaps may hide close/reopen cycles.
Quick-trader and held-to-settlement classifications remain unmeasured pending
complete entry/exit and redemption evidence. The UI says so explicitly.
Changes are retained for 30 days, capped at 1,000; completed spans for 90 days,
capped at 5,000. Position state is capped at 30,000 keys.

## Followability

`docs/research.js` measures forward observations only. A followed whale's live
BUY no older than 30 seconds starts a one-minute timer. The exact asset's CLOB
asks must then support $25 of purchases at prices no more than 2 cents above
the whale fill. Books with missing/old timestamps, HTTP failures, invalid
levels, or timers more than 15 seconds late are unmeasured, not failed trades.

The displayed score is the percentage of measured checks meeting this rule,
after at least 10 measurements. Failures are displayed separately. This is
displayed-depth availability, not guaranteed execution, profitability, or a
cost-adjusted signal. Fees are excluded. There is at most one sample per wallet
per five minutes and eight pending globally. Only fresh live data qualifies;
saved snapshots are never presented as retrospective execution evidence.

Samples persist locally for up to 90 days, capped at 2,000 across wallets.
The browser must stay open and able to reach the websocket and CLOB. No shared
historical followability score is manufactured for visitors who have no samples.

## Verification

Run `node --test tests/*.test.cjs` and
`python -m unittest discover -s tests -p 'test_*.py'`.
Tests cover per-topic aggregation, concentration and sample screens, opposite
outcomes, missing/capped positions, contradictory statuses, adds/reductions,
explicit exits, price/depth limits, stale books, and sample qualification.
