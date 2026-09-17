"""Position lifecycle: what is a tracked whale holding, and when did they leave?

WHY THIS EXISTS
----------------
The trade tape answers "what did they just do." It cannot answer the question
that actually matters for copying someone: are they STILL in this trade, or did
they already get out? A fill on the tape with no exit visible looks identical
whether the whale is still riding it or closed it four minutes later on a fill
this feed's per-wallet cap didn't happen to catch.

Polymarket's /v2/positions endpoint already tracks this server-side -- it is
NOT re-derived from raw fills here, because the API's cost-basis and status
bookkeeping (entries, redemptions, neg-risk conversions) is exactly the fiddly
per-token accounting that is easy to get silently wrong from fills alone. This
module just asks that endpoint two questions per wallet -- what is OPEN, what is
CLOSED -- and packages the answer.

WHAT "EXIT" MEANS HERE, AND WHAT IT DOES NOT MEAN
--------------------------------------------------
A CLOSED position with a recent `last_event_at` is the whale no longer holding
that token: sold out, merged, or redeemed. This module reports that as fact.

It does NOT claim that mirroring their exit timing is profitable. The paper
simulator's own results (pm/paper.py) show naive entry/exit mirroring is
dominated by fee drag and by longshot positions held to resolution rather than
genuine timing skill. Showing "they exited here" is real, checkable data,
consistent with what the user asked to see; treating it as validated trading
advice would not be. The board and the UI must keep those two claims visibly
separate -- the API `status` field states a plain fact; the DEFAULT MIRROR RULE
suggested on the card ("exit at the same point") is a heuristic offered because
it is what was asked for, not a proven strategy.

THE NEG-RISK TRAP
------------------
A position with `negative_risk=true` and `avg_price` sitting right at 0.50 is
very often the RESIDUE of a neg-risk conversion (holding "NO" on every other
outcome after converting a directional bet on one outcome), not a fill the
wallet actively chose at that price. Flagged, not hidden -- see `is_likely_hedge_residue`.
"""

from __future__ import annotations

import concurrent.futures as cf
import sys
from typing import Any

from . import api
from .feed import FEED_VERDICTS

MAX_OPEN_PER_WALLET = 12
MAX_CLOSED_PER_WALLET = 8
# a CLOSED position older than this is not "they just exited" any more
RECENT_EXIT_WINDOW_S = 7 * 86400


def is_likely_hedge_residue(p: dict) -> bool:
    return bool(p.get("negative_risk")) and abs(float(p.get("avg_price") or 0) - 0.5) < 0.02


def _wallet_positions(wallet: str) -> tuple[list[dict], list[dict]]:
    try:
        open_ = api.user_positions(wallet, cap=MAX_OPEN_PER_WALLET, status="OPEN")
    except api.PolymarketError as e:
        print(f"  ! positions(open) {wallet}: {e}", file=sys.stderr)
        open_ = []
    try:
        closed = api.user_positions(wallet, cap=MAX_CLOSED_PER_WALLET, status="CLOSED")
    except api.PolymarketError as e:
        print(f"  ! positions(closed) {wallet}: {e}", file=sys.stderr)
        closed = []
    return open_, closed


def _normalize(p: dict, card: dict, status: str) -> dict:
    avg_price = float(p.get("avg_price") or 0)
    current_price = float(p.get("current_price") or 0)
    size = float(p.get("current_size") or 0) if status == "OPEN" else float(p.get("total_size") or 0)
    return {
        "wallet": card["wallet"],
        "name": card.get("name"),
        "verdict": card.get("verdict"),
        "discovered": bool(card.get("discovered")),
        "status": status,                      # OPEN | CLOSED, a fact from the API
        "title": p.get("title") or "",
        "slug": p.get("slug") or "",
        "outcome": p.get("outcome") or "",
        "avg_price": round(avg_price, 4),
        "current_price": round(current_price, 4),
        "size": round(size, 4),
        "cost_usd": round(float(p.get("total_cost_usdc") or p.get("entry_cost_usdc") or 0), 2),
        "value_usd": round(float(p.get("current_value") or 0), 2),
        "realized_pnl": round(float(p.get("realized_pnl") or 0), 2),
        "unrealized_pnl": round(float(p.get("unrealized_pnl") or 0), 2),
        "total_pnl": round(float(p.get("total_pnl") or 0), 2),
        "percent_pnl": p.get("percent_pnl"),
        "last_event_at": p.get("last_event_at"),
        "redeemable": bool(p.get("redeemable")),
        "likely_hedge_residue": is_likely_hedge_residue(p),
        "end_date": p.get("end_date"),
    }


def build_positions(cards: list[dict], *, workers: int = 8, now_ts: int,
                    log=print) -> dict[str, Any]:
    whales = [c for c in cards if c.get("verdict") in FEED_VERDICTS]
    log(f"  positions: pulling open+closed for {len(whales)} screened whales")

    open_out: list[dict] = []
    closed_out: list[dict] = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_wallet_positions, c["wallet"]): c for c in whales}
        for fut in cf.as_completed(futs):
            card = futs[fut]
            opened, closed = fut.result()
            for p in opened:
                open_out.append(_normalize(p, card, "OPEN"))
            for p in closed:
                rec = _normalize(p, card, "CLOSED")
                last = rec.get("last_event_at")
                if last and (now_ts - int(last)) <= RECENT_EXIT_WINDOW_S:
                    closed_out.append(rec)

    open_out.sort(key=lambda r: -(r.get("last_event_at") or 0))
    closed_out.sort(key=lambda r: -(r.get("last_event_at") or 0))

    log(f"  positions: {len(open_out)} open, {len(closed_out)} recently closed "
        f"(within {RECENT_EXIT_WINDOW_S // 86400}d)")
    return {
        "generated_at": now_ts,
        "open": open_out,
        "recently_closed": closed_out,
        "note": ("OPEN/CLOSED is a fact from Polymarket's own position ledger, not "
                 "a signal we compute. 'Recently closed' means the whale exited that "
                 "token within the last 7 days -- it is what happened, not advice on "
                 "when you should have exited. A position with negative_risk=true and "
                 "avg_price near 0.50 (flagged likely_hedge_residue) is often left over "
                 "from a neg-risk conversion, not a price the wallet actively chose."),
    }
