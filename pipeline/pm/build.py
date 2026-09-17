"""Build the static JSON the dashboard reads.

Runs in GitHub Actions on a schedule. GitHub Pages cannot run a server, so this
is the backend: it does the expensive multi-call scoring here, commits compact
JSON, and the browser just renders it. Live data does NOT come through here --
the page opens its own websocket for that (see docs/app.js).

Usage:
    python -m pm.build --top 120 --out ../docs/data
    python -m pm.build --top 20 --no-discover     # quick local run
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import time
from typing import Any

from . import api
from .feed import build_feed
from .positions import build_positions
from .score import score_wallet

# Addresses that are protocol infrastructure, not traders. They surface in
# /v2/holders as enormous zero-basis positions and would otherwise dominate any
# discovery sweep.
SINKS = {
    "0x0000000000000000000000000000000000000000",
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",  # ConditionalTokens
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",  # CTF Exchange
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",  # NegRisk Adapter
    "0xa5ef39c3d3e10d0b270233af41cec5a9c8ea8c39",
}


# All 12 categories the leaderboard actually accepts, enumerated live on
# 2026-09-17 by probing candidates: a real one returns rows, an invalid one
# returns an EMPTY array (not an error), which is how the set was established.
# Each returns a substantially different wallet population -- measured novelty
# against an overall baseline ran from 29% (sports) to 75% (weather) -- so this
# is genuine discovery, not a re-ranking of the same names.
CATEGORIES = ("sports", "crypto", "politics", "esports", "combos",
              "economics", "tech", "culture", "mentions", "weather", "finance")

# Notional floor for the recent-activity scanner. Wallets are found by having
# placed a single trade this size, which surfaces people trading size NOW --
# a population the cumulative leaderboard is structurally slow to show.
BIG_TRADE_USD = 10_000


def _norm(addr: str | None) -> str | None:
    return addr.lower() if isinstance(addr, str) and addr.startswith("0x") else None


def gather_candidates(top: int, discover: bool, log) -> dict[str, dict]:
    """Assemble the wallet pool from several angles.

    Pulling more than one window and both sort keys is deliberate. An all-time
    PnL board is dominated by wallets that made one enormous bet years ago; a
    month board surfaces who is actually active now; a VOLUME board surfaces the
    market makers we specifically want to identify and exclude. Three views of
    the same population make the selection bias visible instead of hidden.
    """
    pool: dict[str, dict] = {}

    # "day" added alongside all/month/week: its PNL-sorted rank+pnl are captured
    # onto the pool entry (below) so the frontend can offer "best today" /
    # "best this week" as sort keys on the SAME fully-screened board, rather
    # than a separate, less rigorous list. Every wallet gathered here still
    # goes through the full score_wallet() gate -- concentration, curve
    # quality, program-income share -- regardless of which window found it.
    for period in ("day", "week", "month", "all"):
        for sort_by in ("PNL", "VOLUME"):
            try:
                rows = api.leaderboard(time_period=period, sort_by=sort_by, limit=top)
            except api.PolymarketError as e:
                log(f"  ! leaderboard {period}/{sort_by} failed: {e}")
                continue
            for r in rows:
                w = _norm(r.get("user_id") or r.get("proxy_wallet"))
                if not w or w in SINKS:
                    continue
                e = pool.setdefault(w, {"wallet": w, "sources": [], "name": None})
                e["sources"].append(f"lb:{period}:{sort_by.lower()}")
                e["name"] = e["name"] or r.get("user_name") or None
                if sort_by == "PNL":
                    # keep the PNL-window figures; VOLUME-sort rank is a
                    # different ranking and would misrepresent "best today"
                    e[f"lb_{period}_pnl"] = r.get("pnl")
                    e[f"lb_{period}_rank"] = r.get("rank")
            log(f"  leaderboard {period:<5} {sort_by:<6} -> {len(rows):>4} rows "
                f"(pool now {len(pool)})")

    # CATEGORY-SCOPED BOARDS. Verified 2026-09-17: category=sports|crypto|
    # politics|esports|combos each return a DIFFERENT wallet set, and an
    # unknown category returns empty rather than silently falling back to
    # overall -- so this param is genuinely honoured and safe to trust.
    # Two wins at once: many wallets the overall board never surfaces, and an
    # AUTHORITATIVE category label straight from Polymarket, rather than one
    # inferred from market titles with a regex.
    for cat in CATEGORIES:
        for period in ("week", "month"):
            try:
                rows = api.leaderboard(time_period=period, sort_by="PNL",
                                       limit=top, category=cat)
            except api.PolymarketError as e:
                log(f"  ! leaderboard {cat}/{period} failed: {e}")
                continue
            for r in rows:
                w = _norm(r.get("user_id") or r.get("proxy_wallet"))
                if not w or w in SINKS:
                    continue
                e = pool.setdefault(w, {"wallet": w, "sources": [], "name": None})
                e["sources"].append(f"lb:{cat}:{period}")
                e["name"] = e["name"] or r.get("user_name") or None
                e.setdefault("lb_categories", set()).add(cat)
            log(f"  leaderboard {cat:<9} {period:<6} -> {len(rows):>4} rows "
                f"(pool now {len(pool)})")

    if discover:
        # Whale DISCOVERY: walk the top holders of the most liquid markets to
        # find profitable wallets that never appear on any leaderboard. This is
        # the part a generic whale tracker does not do -- and it is the only way
        # to escape the survivorship-selected pool everyone else copies.
        try:
            mk = api.markets_keyset(limit=100, closed=False, order="volumeNum",
                                    ascending=False, max_pages=1)
            log(f"  discovery: scanning holders of {len(mk)} liquid markets")
            found = 0
            for m in mk[:40]:
                cid = m.get("conditionId")
                if not cid:
                    continue
                try:
                    groups = api.market_holders(cid, include_pnl=True, limit=100)
                except api.PolymarketError:
                    continue
                for g in groups:
                    for h in (g.get("holders") or []):
                        w = _norm(h.get("proxy_wallet"))
                        if not w or w in SINKS or w in pool:
                            continue
                        if abs(float(h.get("total_pnl") or 0)) < 25_000:
                            continue
                        pool[w] = {"wallet": w, "sources": ["discovery:holders"],
                                   "name": h.get("name")}
                        found += 1
            log(f"  discovery: +{found} wallets never seen on a leaderboard")
        except api.PolymarketError as e:
            log(f"  ! discovery failed: {e}")

        # RECENT-ACTIVITY SCANNER. Everything above ranks on cumulative
        # standing, so a wallet that started trading size last week is invisible
        # to all of it. This finds anyone who placed a single trade over
        # BIG_TRADE_USD in roughly the last 45 days.
        try:
            big = api.big_trades(BIG_TRADE_USD, cap=1500)
            found = 0
            for t in big:
                w = _norm(t.get("proxy_wallet"))
                if not w or w in SINKS or w in pool:
                    continue
                pool[w] = {"wallet": w, "sources": ["discovery:big-trade"],
                           "name": t.get("name")}
                found += 1
            log(f"  big trades (>=${BIG_TRADE_USD:,}): {len(big)} fills -> "
                f"+{found} wallets not seen on any board")
        except api.PolymarketError as e:
            log(f"  ! big-trade scan failed: {e}")

    return pool


def score_one(entry: dict, now_ts: int) -> dict | None:
    w = entry["wallet"]
    try:
        stats = api.user_stats(w)
        if not stats:
            return None
        pts = api.user_pnl(w, interval="max", fidelity="1d")
        card = score_wallet(stats, pts, now_ts=now_ts)
        card["name"] = entry.get("name") or None
        card["sources"] = sorted(set(entry.get("sources") or []))
        card["discovered"] = any(s.startswith("discovery")
                                 for s in card["sources"])
        # Carry the leaderboard's own short-window PnL through onto the card.
        # These are RAW, self-reported figures from Polymarket's board, not
        # something this pipeline computed -- present them as "today's/this
        # week's leaderboard shows X", not as a re-verified number.
        for period in ("day", "week", "month", "all"):
            card[f"lb_{period}_pnl"] = entry.get(f"lb_{period}_pnl")
            card[f"lb_{period}_rank"] = entry.get(f"lb_{period}_rank")
        # Polymarket's OWN category labels, from the category-scoped boards this
        # wallet appeared on. Authoritative, unlike the regex inference in
        # feed.py, so the UI prefers these when present.
        cats = entry.get("lb_categories")
        card["lb_categories"] = sorted(cats) if cats else []
        return card
    except Exception as e:  # noqa: BLE001 - one bad wallet must not kill the build
        print(f"  ! score {w}: {e}", file=sys.stderr)
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100,
                    help="rows to pull per leaderboard view")
    ap.add_argument("--out", default="../docs/data")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--no-discover", action="store_true")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap wallets scored (for quick local runs)")
    ap.add_argument("--no-feed", action="store_true",
                    help="skip the screened-whale trade feed")
    ap.add_argument("--no-positions", action="store_true",
                    help="skip the open/recently-closed position tracker")
    args = ap.parse_args()

    t0 = time.time()
    now_ts = int(t0)

    def log(m: str) -> None:
        print(m, flush=True)

    log("== gathering candidate wallets ==")
    pool = gather_candidates(args.top, not args.no_discover, log)
    entries = list(pool.values())
    if args.limit:
        entries = entries[:args.limit]
    log(f"== scoring {len(entries)} wallets ==")

    cards: list[dict] = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(score_one, e, now_ts): e for e in entries}
        for fut in cf.as_completed(futs):
            c = fut.result()
            done += 1
            if c:
                cards.append(c)
            if done % 10 == 0 or done == len(entries):
                log(f"  {done}/{len(entries)} scored ({len(cards)} ok) "
                    f"{time.time() - t0:.0f}s")

    # Rank by Net/DD -- drawdown first, profit second -- and only among wallets
    # with enough sample to rank. Everything else is still published, just not
    # ordered, because ordering it would imply a confidence we do not have.
    rankable = [c for c in cards if c.get("rankable")]
    rest = [c for c in cards if not c.get("rankable")]
    rankable.sort(key=lambda c: (c.get("net_dd") is None, -(c.get("net_dd") or 0)))
    rest.sort(key=lambda c: -(c.get("position_pnl") or 0))
    ordered = rankable + rest

    os.makedirs(args.out, exist_ok=True)

    counts: dict[str, int] = {}
    for c in ordered:
        counts[c["verdict"]] = counts.get(c["verdict"], 0) + 1

    meta = {
        "generated_at": now_ts,
        "wallets_scored": len(ordered),
        "rankable": len(rankable),
        "discovered": sum(1 for c in ordered if c.get("discovered")),
        "verdicts": counts,
        "build_seconds": round(time.time() - t0, 1),
        "notes": [
            "Ranked by Net/DD among wallets with >=100 fills and >=60 days of curve.",
            "Drawdown is measured on position_pnl (mark-inclusive), so open-position "
            "pain is included -- realized-only curves hide it.",
            "A high rank is NOT a copy signal. It is a starting point for the "
            "forward test; past PnL rank has no demonstrated forward information.",
        ],
    }

    # Feed and category tagging run BEFORE whales.json is written, because the
    # feed fetch is where per-wallet category (crypto/sports/politics/macro) is
    # derived -- pulling trades a second time just to classify would double the
    # API calls for nothing.
    if not args.no_feed:
        feed, profiles = build_feed(ordered, workers=args.workers, log=log)
        feed["generated_at"] = now_ts
        meta["feed_trades"] = len(feed["trades"])
        meta["feed_newest_ts"] = feed["newest_ts"]
        _write(os.path.join(args.out, "whale_trades.json"), feed)

        cat_counts: dict[str, int] = {}
        for c in ordered:
            prof = profiles.get((c.get("wallet") or "").lower())
            if prof:
                c["category"] = prof["category"]
                c["category_confidence"] = prof["category_confidence"]
                c["category_breakdown"] = prof["category_breakdown"]
                cat_counts[prof["category"]] = cat_counts.get(prof["category"], 0) + 1
        meta["categories"] = cat_counts

    _write(os.path.join(args.out, "whales.json"), ordered)

    # Position lifecycle: what tracked whales are holding right now, and what
    # they exited in the last 7 days. See positions.py for why OPEN/CLOSED is
    # read from Polymarket's own ledger rather than re-derived from fills.
    if not args.no_positions:
        positions = build_positions(ordered, workers=args.workers, now_ts=now_ts, log=log)
        meta["positions_open"] = len(positions["open"])
        meta["positions_recently_closed"] = len(positions["recently_closed"])
        _write(os.path.join(args.out, "whale_positions.json"), positions)

    _write(os.path.join(args.out, "meta.json"), meta)

    log(f"\n== wrote {len(ordered)} scorecards to {args.out} "
        f"in {meta['build_seconds']}s ==")
    for v, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        log(f"   {v:<14} {n}")
    return 0


def _write(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    raise SystemExit(main())
