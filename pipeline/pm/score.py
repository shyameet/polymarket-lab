"""Turn a wallet's raw API numbers into a scorecard that answers the only
question that matters: *is this person's edge real, and could I actually copy it?*

WHY THIS FILE IS THE WHOLE PROJECT
----------------------------------
A leaderboard sorted by lifetime PnL is a sorted in-sample pool. Ranking on it
carries no forward information -- it selects for whoever took the biggest bet
and won, which is not a repeatable property. Two live examples, both measured:

  Theo4    #1 all-time, $22.05M. Also: $8.30M of that from ONE position (38%),
           14 distinct markets, 4 of 24 months positive, $5.39M peak-to-trough,
           no activity since Feb 2026. A lottery ticket that hit.

  "Car"    10,022 closed positions, 88% positive months, top-5 = 14.6% of PnL.
           Statistically real -- and 81% maker fills with 6.3% of profit from
           liquidity rewards. Structurally uncopyable: you cannot follow a
           market maker into a quote.

Neither is a copy-trading candidate, and a PnL sort puts both at the top. So we
score for DURABILITY and COPYABILITY, and we report drawdown before profit.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

# A wallet needs at least this many fills before any of its ratios mean
# anything. Below it we report the numbers but refuse to rank the wallet --
# a 90% win rate over 10 trades is noise wearing a suit.
MIN_TRADES_FOR_RANKING = 100

# Equity series shorter than this can't express a drawdown honestly.
MIN_DAYS_FOR_RANKING = 60

# A curve must actually MOVE this many times before its drawdown means
# anything. Guards against the API's back-filled flat lines (see
# drawdown_from_curve) which otherwise produce a perfect, unbeatable Net/DD.
MIN_CURVE_MOVES = 10

# Above this fill rate you are not looking at a person making decisions you
# could follow -- you are looking at software. It is a REACHABILITY test, not a
# skill test: a bot placing thousands of bets a day may well be profitable, but
# at ~2s Polygon block times you cannot see, decide and mirror fast enough for
# any of it to transfer. Measured on the live board, 29 of 150 wallets rated
# "worth following" were running 500-7,000 bets/day.
MAX_FILLS_PER_DAY = 500


def _f(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def drawdown_from_curve(points: list[dict], field: str = "position_pnl") -> dict:
    """Max peak-to-trough on the wallet's equity curve.

    /v2/user-pnl points are CUMULATIVE running totals, so the series IS the
    equity curve -- no integration needed.

    We measure on `position_pnl` (realized + unrealized), not `realized_pnl`,
    deliberately. Realized-only curves hide open-position drawdown: a wallet
    sitting on a position 60% underwater shows a flat realized line right up
    until it closes. Mark-inclusive is what an account actually experiences,
    and what a trailing-drawdown account would have been liquidated on.
    """
    if not points:
        return {"max_dd_usd": 0.0, "max_dd_pct": 0.0, "peak_usd": 0.0,
                "final_usd": 0.0, "distinct_values": 0, "move_days": 0,
                "days": 0, "dd_start": None, "dd_trough": None}

    series = [(int(_f(p.get("timestamp"))), _f(p.get(field))) for p in points]
    series.sort(key=lambda x: x[0])

    # Seed the curve at zero before the first observation.
    #
    # This is not cosmetic. The API's first point is already post-trading: one
    # live wallet's series OPENS at -$176,289. Seeding the peak at that first
    # value treats "already six figures down" as the high-water mark, so the
    # whole inception drawdown vanishes and the wallet reports MaxDD = $0 with
    # an undefined Net/DD -- i.e. it looks riskless precisely because it lost
    # money immediately and never looked back. Cumulative PnL is 0 at inception
    # by definition, so that is where the peak must start.
    if series[0][1] != 0.0:
        series.insert(0, (series[0][0] - 86400, 0.0))

    peak = series[0][1]
    peak_ts = series[0][0]
    max_dd = 0.0
    max_dd_pct = 0.0
    dd_start = dd_trough = None

    for ts, v in series:
        if v > peak:
            peak, peak_ts = v, ts
        dd = peak - v
        if dd > max_dd:
            max_dd = dd
            # percentage only means something against a positive peak
            max_dd_pct = (dd / peak * 100.0) if peak > 0 else 0.0
            dd_start, dd_trough = peak_ts, ts

    # --- curve quality -----------------------------------------------------
    # The API sometimes returns a DEGENERATE curve: the final PnL projected
    # backwards as a flat line. One live wallet's 93-point series was a single
    # value repeated 93 times; another had 2 distinct values across 83 points.
    #
    # A flat line has zero variance, therefore zero drawdown, therefore an
    # INFINITE Net/DD -- which would sort it straight to the top of a
    # drawdown-first ranking. This is the "risk gates select for inactivity"
    # trap: the gate rewards the wallets whose history we cannot actually see.
    # Count real moves so the caller can refuse to rank these.
    real = [(int(_f(p.get("timestamp"))), _f(p.get(field))) for p in points]
    real.sort(key=lambda x: x[0])
    move_days = sum(1 for i in range(1, len(real)) if real[i][1] != real[i - 1][1])

    return {
        "max_dd_usd": round(max_dd, 2),
        "max_dd_pct": round(max_dd_pct, 2),
        "peak_usd": round(max(v for _, v in series), 2),
        "final_usd": round(series[-1][1], 2),
        "distinct_values": len({v for _, v in real}),
        "move_days": move_days,
        # count real observations only, not the synthetic zero-origin point
        "days": len({_dt.datetime.utcfromtimestamp(int(_f(p.get("timestamp")))).date()
                     for p in points if _f(p.get("timestamp"))}),
        "dd_start": dd_start,
        "dd_trough": dd_trough,
    }


def monthly_consistency(points: list[dict], field: str = "position_pnl") -> dict:
    """Share of calendar months that finished up.

    Consistency is the cheapest available separator between an edge and a
    jackpot. Theo4 is 4/24. A real market maker is ~88%.
    """
    if not points:
        return {"months": 0, "positive_months": 0, "pct_positive": 0.0,
                "monthly": []}

    by_month: dict[str, tuple[int, float]] = {}
    for p in points:
        ts = int(_f(p.get("timestamp")))
        if not ts:
            continue
        d = _dt.datetime.utcfromtimestamp(ts)
        key = f"{d.year:04d}-{d.month:02d}"
        v = _f(p.get(field))
        # keep the LAST observation in each month (cumulative curve)
        if key not in by_month or ts >= by_month[key][0]:
            by_month[key] = (ts, v)

    keys = sorted(by_month)
    monthly = []
    prev = None
    for k in keys:
        cum = by_month[k][1]
        delta = cum if prev is None else cum - prev
        monthly.append({"month": k, "pnl": round(delta, 2)})
        prev = cum

    # the first month is a partial/seed period, not a traded month
    scored = monthly[1:] if len(monthly) > 1 else monthly
    pos = sum(1 for m in scored if m["pnl"] > 0)
    return {
        "months": len(scored),
        "positive_months": pos,
        "pct_positive": round(pos / len(scored) * 100.0, 1) if scored else 0.0,
        "monthly": monthly,
    }


def score_wallet(stats: dict, points: list[dict], *, now_ts: int) -> dict:
    """Build the full scorecard. `stats` is /v2/user-stats .data, `points` is
    /v2/user-pnl .data.points at 1d fidelity."""
    at = stats.get("all_time_pnl") or {}

    realized_market = _f(at.get("realized_market_pnl"))
    unrealized = _f(at.get("unrealized_pnl"))
    position_pnl = _f(at.get("position_pnl"))
    economic_pnl = _f(at.get("economic_pnl"))
    volume_usdc = _f(at.get("volume_usdc"))
    fees_paid = _f(at.get("fees_paid"))
    biggest_win = _f(stats.get("biggest_win"))
    trade_count = int(_f(at.get("trade_count")))

    # Program income: rebates, liquidity rewards, referrals, yield. Real money,
    # but it accrues to market-making and referral behaviour, NOT to a directional
    # view -- so none of it transfers to someone copying the trades.
    program_income = (_f(at.get("maker_rebate")) + _f(at.get("taker_rebate"))
                      + _f(at.get("reward_income")) + _f(at.get("referral_income"))
                      + _f(at.get("yield_income")) + _f(at.get("fees_refunded")))

    dd = drawdown_from_curve(points)
    cons = monthly_consistency(points)

    # --- the four discriminators -------------------------------------------

    # 1. Net/DD. The owner's first-order metric: profit earned per dollar of
    #    peak-to-trough pain. Scale-invariant, so it compares across bankrolls.
    net_dd = (position_pnl / dd["max_dd_usd"]) if dd["max_dd_usd"] > 0 else None

    # 2. Concentration. What share of lifetime profit came from the single
    #    best position? High = the record is one bet, not a process.
    concentration = (biggest_win / realized_market) if realized_market > 0 else None

    # 3. Program-income share. High = market maker / farmer. Uncopyable.
    program_share = (program_income / economic_pnl) if economic_pnl > 0 else None

    # 4. Edge per dollar traded. Above ~20% is a concentrated directional
    #    bettor (few, large, high-conviction). Below ~3% at nine-figure volume
    #    is a market maker grinding spread. Copyable edge lives in between.
    edge_per_dollar = (realized_market / volume_usdc) if volume_usdc > 0 else None

    last_ts = max((int(_f(p.get("timestamp"))) for p in points), default=0)
    days_idle = int((now_ts - last_ts) / 86400) if last_ts else None

    flags: list[str] = []
    if position_pnl <= 0:
        flags.append("NON-PROFITABLE: lifetime position PnL is zero or negative")
    degenerate = dd["move_days"] < MIN_CURVE_MOVES
    if degenerate:
        flags.append(
            f"NO REAL CURVE: equity series moves only {dd['move_days']}x across "
            f"{dd['days']} days ({dd['distinct_values']} distinct values) -- the API "
            f"back-filled a flat line, so this drawdown is unmeasured, not low")
    if trade_count < MIN_TRADES_FOR_RANKING:
        flags.append(f"THIN SAMPLE: {trade_count} fills -- ratios are noise")
    if dd["days"] < MIN_DAYS_FOR_RANKING:
        flags.append(f"SHORT HISTORY: {dd['days']} days of curve")
    if concentration is not None and concentration >= 0.30:
        flags.append(
            f"ONE-BET RECORD: {concentration:.0%} of lifetime PnL is a single position")
    if program_share is not None and program_share >= 0.15:
        flags.append(
            f"UNCOPYABLE INCOME: {program_share:.0%} of profit is rebates/rewards, not trades")
    if edge_per_dollar is not None and edge_per_dollar < 0.03 and volume_usdc > 5e7:
        flags.append("MARKET-MAKER SHAPE: sub-3% edge on very high volume")
    if cons["months"] >= 6 and cons["pct_positive"] < 40:
        flags.append(
            f"LUMPY: only {cons['pct_positive']:.0f}% of months positive")
    if days_idle is not None and days_idle > 60:
        flags.append(f"DORMANT: no activity for {days_idle} days")
    if unrealized > 0 and position_pnl > 0 and unrealized / position_pnl > 0.5:
        flags.append(
            f"UNBANKED: {unrealized / position_pnl:.0%} of PnL is unrealized marks, not cash")

    fills_per_day = trade_count / max(dd["days"], 1)
    machine = fills_per_day > MAX_FILLS_PER_DAY
    if machine:
        flags.append(
            f"TOO FAST TO FOLLOW: about {fills_per_day:,.0f} bets a day "
            f"({trade_count:,} over {dd['days']} days). That is automated -- by the time "
            f"you saw a bet and placed yours, it would be long gone")

    rankable = (trade_count >= MIN_TRADES_FOR_RANKING
                and dd["days"] >= MIN_DAYS_FOR_RANKING
                and not degenerate
                and not machine)

    return {
        "wallet": stats.get("proxy_wallet"),
        "trade_count": trade_count,
        "join_date": stats.get("join_date"),

        # money
        "realized_market_pnl": round(realized_market, 2),
        "unrealized_pnl": round(unrealized, 2),
        "position_pnl": round(position_pnl, 2),
        "economic_pnl": round(economic_pnl, 2),
        "program_income": round(program_income, 2),
        "fees_paid": round(fees_paid, 2),
        "volume_usdc": round(volume_usdc, 2),
        "biggest_win": round(biggest_win, 2),

        # risk first
        "max_dd_usd": dd["max_dd_usd"],
        "max_dd_pct": dd["max_dd_pct"],
        "net_dd": round(net_dd, 2) if net_dd is not None else None,
        "curve_days": dd["days"],
        "fills_per_day": round(fills_per_day, 1),
        "curve_moves": dd["move_days"],
        "curve_distinct": dd["distinct_values"],

        # durability
        "months": cons["months"],
        "pct_positive_months": cons["pct_positive"],
        # last 24 months only -- the drawer chart shows a fixed window and a
        # full multi-year series on 1,300 cards is most of the payload
        "monthly": cons["monthly"][-24:],

        # copyability
        "concentration": round(concentration, 4) if concentration is not None else None,
        "program_share": round(program_share, 4) if program_share is not None else None,
        "edge_per_dollar": round(edge_per_dollar, 5) if edge_per_dollar is not None else None,
        "days_idle": days_idle,

        "flags": flags,
        "rankable": rankable,
        "verdict": _verdict(flags, rankable, net_dd),
    }


def _verdict(flags: list[str], rankable: bool, net_dd: float | None) -> str:
    """A blunt one-word call. Deliberately pessimistic: the default assumption
    is that a high-PnL wallet is NOT copyable, and it has to earn its way out."""
    if not rankable:
        return "INSUFFICIENT"
    blocking = [f for f in flags
                if f.startswith(("NON-PROFITABLE", "ONE-BET", "UNCOPYABLE", "MARKET-MAKER", "DORMANT",
                                 "TOO FAST TO FOLLOW"))]
    if blocking:
        return "NOT COPYABLE"
    if any(f.startswith(("LUMPY", "UNBANKED")) for f in flags):
        return "FRAGILE"
    if net_dd is not None and net_dd >= 3.0:
        return "CANDIDATE"
    return "WATCH"
