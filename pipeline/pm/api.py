"""Thin, defensive client for Polymarket's public read APIs.

Every quirk encoded here was verified live against production (2026-09-15/16),
not taken from the docs. The docs are wrong or silent about most of them.

THE FIVE TRAPS THIS MODULE EXISTS TO ABSORB
-------------------------------------------
1. Unknown query params are SILENTLY IGNORED with a 200. Passing `window=all`
   to /v2/leaderboard (the real param is `time_period`) returns a normal-looking
   response for the DEFAULT window. There is no error to catch, so every param
   this module sends is whitelisted and typo'd names raise locally instead.
2. /v2/trades defaults to taker_only=TRUE and silently drops maker fills.
   A whale who mostly makes looks like they barely trade.
3. Gamma silently clamps `limit` to 100 (limit=250 returns 100, no error) and
   silently IGNORES active=/archived=. Use `acceptingOrders` for tradability.
4. Gamma /markets and /events serve `deprecation: true, sunset: 2026-05-01`
   (already past). /markets/keyset is the supported cursor-paged replacement.
5. EVERY REST response is CDN-cached `max-age=300`. Both v1 and v2, behind
   CloudFront. `cf-cache-status: DYNAMIC` is a red herring -- Cloudflare passes
   through, CloudFront caches. REST IS NOT REAL TIME. Live data comes from the
   websocket only (see ws.py); REST is for history and scoring.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Any, Iterator

DATA = "https://data-api.polymarket.com"
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

UA = "polymarket-whale-lab/0.1 (research; read-only)"

# Params each endpoint actually understands. Anything else is a typo we refuse
# to send, because the API would accept it silently and hand back wrong data.
_ALLOWED: dict[str, set[str]] = {
    "/v2/leaderboard": {"time_period", "sort_by", "category", "limit", "cursor", "user"},
    "/v2/user-stats": {"user"},
    "/v2/user-pnl": {"user", "interval", "fidelity"},
    "/v2/positions": {
        "user", "condition", "limit", "cursor", "sort_by", "sort_direction",
        "status", "include_pnl",
    },
    "/v2/trades": {
        "user", "condition", "taker_only", "limit", "cursor",
        "sort_by", "sort_direction", "side",
    },
    "/v2/activity": {"user", "limit", "cursor", "sort_by", "sort_direction", "type"},
    "/v2/holders": {"condition", "limit", "include_pnl", "min_balance", "cursor"},
}


class PolymarketError(RuntimeError):
    pass


def _get(base: str, path: str, params: dict[str, Any] | None = None,
         *, retries: int = 4, timeout: int = 45) -> Any:
    """GET with backoff. Validates params against the whitelist when we have one."""
    params = {k: v for k, v in (params or {}).items() if v is not None}

    allowed = _ALLOWED.get(path)
    if allowed is not None:
        unknown = set(params) - allowed
        if unknown:
            # Fail loudly here -- the API would not.
            raise PolymarketError(
                f"{path}: unknown param(s) {sorted(unknown)}. "
                f"Polymarket ignores these SILENTLY and returns default-window "
                f"data that looks correct. Allowed: {sorted(allowed)}"
            )

    # bools must be lowercase json, not Python's True/False
    qs = {k: ("true" if v is True else "false" if v is False else v)
          for k, v in params.items()}
    url = f"{base}{path}"
    if qs:
        url += "?" + urllib.parse.urlencode(qs, doseq=True)

    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                       "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            if attempt == retries - 1:
                break
            time.sleep(1.5 * (2 ** attempt))
    raise PolymarketError(f"GET {url} failed after {retries} tries: {last}") from last


def _paginate(path: str, params: dict[str, Any], *, cap: int | None = None,
              page: int = 500) -> Iterator[dict]:
    """Walk a v2 cursor-paged endpoint to exhaustion (or `cap` rows).

    v2 uses opaque signed cursors in `pagination.next_cursor` and REJECTS
    `offset` outright -- do not try to page these the v1 way.
    """
    p = dict(params)
    p["limit"] = page
    seen = 0
    guard = 0
    while True:
        guard += 1
        if guard > 2000:  # runaway-cursor backstop
            raise PolymarketError(f"{path}: cursor did not terminate after 2000 pages")
        body = _get(DATA, path, p)
        rows = body.get("data") or []
        if not isinstance(rows, list):
            raise PolymarketError(f"{path}: expected list in .data, got {type(rows)}")
        for row in rows:
            yield row
            seen += 1
            if cap and seen >= cap:
                return
        cur = (body.get("pagination") or {}).get("next_cursor")
        if not cur or not rows:
            return
        p["cursor"] = cur


# ---------------------------------------------------------------- leaderboard

def leaderboard(time_period: str = "all", sort_by: str = "PNL",
                limit: int = 100, category: str | None = None) -> list[dict]:
    """Official board. NOTE: `time_period` DEFAULTS TO 'day', not 'all'.

    Semantics differ by window and this matters:
      - day/week/month -> MARKED equity change, INCLUDING unrealized marks
      - all            -> realized-only lifetime ledger
    So "day PnL" and "all-time PnL" are not the same quantity and must not be
    summed, compared, or ranked against each other.

    `volume` on this endpoint is denominated in SHARES, not USDC. Use
    user_stats()['volume_usdc'] for money.
    """
    if time_period not in {"day", "week", "month", "all"}:
        raise PolymarketError(f"bad time_period {time_period!r}")
    if sort_by not in {"PNL", "VOLUME"}:
        raise PolymarketError(f"bad sort_by {sort_by!r}")
    rows = list(_paginate("/v2/leaderboard",
                          {"time_period": time_period, "sort_by": sort_by,
                           "category": category},
                          cap=limit, page=min(limit, 1000)))
    return rows


def user_stats(wallet: str) -> dict | None:
    """Full PnL decomposition for one wallet. The most information-dense call
    in the whole API -- it separates tradeable edge from program income.

    Key fields:
      realized_market_pnl  pure realized trading PnL (what a copier could chase)
      unrealized_pnl       marks on open positions (NOT money yet)
      maker_rebate         \\
      taker_rebate          | program income. A market maker's "profit" can be
      reward_income        /  mostly this, and NONE of it is copyable.
      fees_paid            taker fees since 2026-03-30
      volume_usdc          money traded (vs `volume`, which is SHARES)
      biggest_win          single largest winning position -- concentration tell
      trade_count          fills
    """
    body = _get(DATA, "/v2/user-stats", {"user": wallet})
    return body.get("data")


def user_pnl(wallet: str, interval: str = "max", fidelity: str = "1d") -> list[dict]:
    """Daily PnL time series -> this is the EQUITY CURVE, and therefore the only
    way to compute a real max drawdown per wallet.

    Default fidelity is 1h, which returns ~10MB for an active wallet. Always
    pass 1d unless you specifically need intraday.
    """
    body = _get(DATA, "/v2/user-pnl",
                {"user": wallet, "interval": interval, "fidelity": fidelity},
                timeout=120)
    return (body.get("data") or {}).get("points") or []


def user_positions(wallet: str, *, cap: int | None = None,
                   status: str | None = None) -> list[dict]:
    """Positions with realized/unrealized split.

    COST-BASIS TRAP: `entry_cost_usdc` is the basis of what is STILL HELD
    (avg_price * current_size) and collapses to 0 once a position is fully
    exited. It is useless as a lifetime denominator and is zero on most CLOSED
    rows. Lifetime cost = total_size * avg_price.
    """
    return list(_paginate("/v2/positions",
                          {"user": wallet, "status": status, "include_pnl": True},
                          cap=cap))


def user_trades(wallet: str, *, cap: int | None = None) -> list[dict]:
    """Full fill history.

    taker_only=False is NOT optional. The API defaults it to True and silently
    drops every maker fill -- one wallet returned 100 rows on the default and
    971 with the flag.

    Do NOT use `trade_count` from user_stats as a completeness check: measured
    drift of +4 and +123 rows on real wallets, so the two counters disagree by
    construction. Trust cursor exhaustion, not the counter.
    """
    return list(_paginate("/v2/trades", {"user": wallet, "taker_only": False},
                          cap=cap))


def market_holders(condition_id: str, *, include_pnl: bool = True,
                   limit: int = 100, min_balance: float | None = None) -> list[dict]:
    """Top holders of a market -- THE whale-discovery primitive.

    This is how we find traders nobody has heard of, rather than re-ranking the
    same leaderboard everyone else already copies. With include_pnl the cap is
    100 per outcome token; without it, 1000.

    Protocol sink addresses appear here as huge zero-basis holders and must be
    filtered (the API itself rejects some with "a protocol contract address").
    """
    body = _get(DATA, "/v2/holders",
                {"condition": condition_id, "include_pnl": include_pnl,
                 "limit": limit, "min_balance": min_balance})
    return body.get("data") or []


# --------------------------------------------------------------------- gamma

def markets_keyset(*, limit: int = 100, closed: bool | None = False,
                   order: str | None = "volumeNum", ascending: bool = False,
                   max_pages: int = 40, **filters) -> list[dict]:
    """Market metadata via the SUPPORTED cursor endpoint.

    /markets and /events are deprecated with sunset 2026-05-01 (already past)
    and serve `warning: 299 - use /markets/keyset`.

    `limit` is silently clamped to 100 server-side, so we don't pretend
    otherwise. `active=`/`archived=` are silently IGNORED -- they are not
    tradability flags (active was true on 200/200 resolved closed markets).
    Use `acceptingOrders` from the payload instead.
    """
    out: list[dict] = []
    cursor = None
    for _ in range(max_pages):
        p = {"limit": min(limit, 100), "closed": closed, "order": order,
             "ascending": ascending, **filters}
        if cursor:
            p["after_cursor"] = cursor
        body = _get(GAMMA, "/markets/keyset", p)
        rows = body.get("markets") or []
        out.extend(rows)
        cursor = body.get("next_cursor")
        if not cursor or not rows:
            break
    return out


def parse_json_field(value):
    """Gamma returns `outcomes`, `outcomePrices` and `clobTokenIds` as
    JSON-ENCODED STRINGS, not arrays. They must be parsed then index-correlated
    against each other.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return []
    return value or []
