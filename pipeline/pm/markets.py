"""Markets bucketed by how soon they close.

WHY THIS EXISTS
---------------
Everything else in this pipeline is WHALE-centric (who to follow). This is
MARKET-centric: what can be traded right now, grouped by urgency. The owner's
stated primary use case is the "next few hours to end of day" bucket
specifically -- that is deliberately the first tab, not an afterthought.

THE TRAP THIS IS HARDENED AGAINST
----------------------------------
`closed=false` on Gamma does NOT mean "hasn't happened yet" -- it means
Polymarket has not marked it resolved. A market whose endDate was months ago
can still show closed=false if nobody has resolved it. Querying with only
`end_date_max=<soon>` therefore returns stale, overdue, unresolved markets
sorted by their (often huge, long-accumulated) lifetime volume, NOT genuinely
upcoming ones. Verified live 2026-09-18: an end_date_max-only query surfaced
markets dated 2026-06-01, over three months in the past.

The fix is a FLOOR as well as a ceiling: `end_date_min=now` alongside
`end_date_max=<bucket boundary>`. With both bounds, every result was confirmed
live to have `acceptingOrders=true` and a real near-term endDate.

BUCKETS ARE NESTED, NOT MUTUALLY EXCLUSIVE
--------------------------------------------
"Next 4 hours" markets are a subset of "today", which is a subset of "this
month". Each bucket is simply "ends between now and X" for increasing X. This
matches how the feature was asked for -- picking "today" should still show the
urgent few-hour markets, not hide them behind a separate tab.

TIMEZONE: all boundaries are UTC. "Day end" means the next UTC midnight, not
US ET or India IST. This is stated plainly in the UI rather than assumed
silently, because this project's own history has three separate incidents of a
silent timezone assumption being wrong.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from . import api

# label -> hours-from-now for the boundary. "day"/"weekend"/"month"/"year" are
# computed as real calendar boundaries below, not fixed hour counts.
FEW_HOURS = 4
MARKETS_PER_BUCKET = 40


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _bucket_bounds(now: dt.datetime) -> dict[str, dt.datetime]:
    """Real UTC calendar boundaries, computed from `now`."""
    day_end = (now + dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

    # "this weekend": the coming Saturday 00:00 -> Sunday 23:59:59 UTC. If we
    # are already inside a weekend, the window runs to THIS Sunday, not next.
    dow = now.weekday()  # Mon=0 .. Sun=6
    if dow == 5:          # Saturday
        weekend_end = (now + dt.timedelta(days=1)).replace(hour=23, minute=59, second=59)
    elif dow == 6:         # Sunday
        weekend_end = now.replace(hour=23, minute=59, second=59)
    else:
        days_to_sun = 6 - dow
        weekend_end = (now + dt.timedelta(days=days_to_sun)).replace(
            hour=23, minute=59, second=59)

    if now.month == 12:
        month_end = now.replace(year=now.year + 1, month=1, day=1,
                                hour=0, minute=0, second=0, microsecond=0)
    else:
        month_end = now.replace(month=now.month + 1, day=1,
                                hour=0, minute=0, second=0, microsecond=0)

    year_end = now.replace(year=now.year + 1, month=1, day=1,
                           hour=0, minute=0, second=0, microsecond=0)

    return {
        "hours": now + dt.timedelta(hours=FEW_HOURS),
        "today": day_end,
        "weekend": weekend_end,
        "month": month_end,
        "year": year_end,
    }


def _fetch_window(lo: str, hi: str, *, limit: int, log) -> list[dict]:
    try:
        rows = api.markets_keyset(limit=limit, closed=False, order="volumeNum",
                                  ascending=False, max_pages=1,
                                  end_date_min=lo, end_date_max=hi)
    except api.PolymarketError as e:
        log(f"  ! markets window {lo}..{hi}: {e}")
        return []

    out = []
    for m in rows:
        if not m.get("acceptingOrders", True):
            continue
        outcomes = api.parse_json_field(m.get("outcomes"))
        prices = api.parse_json_field(m.get("outcomePrices"))
        out.append({
            "slug": m.get("slug") or "",
            "title": m.get("question") or "",
            "end_date": m.get("endDate") or "",
            "volume": float(m.get("volumeNum") or 0),
            "liquidity": float(m.get("liquidityNum") or 0),
            "outcomes": outcomes,
            "prices": [float(p) for p in prices] if prices else [],
            "neg_risk": bool(m.get("negRisk")),
        })
    return out


def build_markets_soon(*, now_ts: int, log=print) -> dict[str, Any]:
    now = dt.datetime.fromtimestamp(now_ts, tz=dt.timezone.utc)
    bounds = _bucket_bounds(now)
    lo = _iso(now)

    log(f"  markets: bucketing by close time from {lo}")
    out: dict[str, list[dict]] = {}
    for key, boundary in bounds.items():
        hi = _iso(boundary)
        rows = _fetch_window(lo, hi, limit=MARKETS_PER_BUCKET, log=log)
        out[key] = rows
        log(f"  markets {key:<8} (by {hi[:16]}) -> {len(rows)} open, accepting orders")

    return {
        "generated_at": now_ts,
        "buckets": out,
        "bucket_ends": {k: _iso(v) for k, v in bounds.items()},
        "note": ("All boundaries are UTC, not ET or IST. Buckets are NESTED -- "
                 "'today' includes everything in 'next few hours' too, not a "
                 "separate slice. Sorted by volume within each window; "
                 "acceptingOrders=false markets are excluded."),
    }
