"""Build the WHALE TRADE FEED -- recent fills by wallets that passed the screen.

WHY THIS EXISTS (it is not just a nicety)
-----------------------------------------
The live websocket tape runs in the visitor's own browser, which means it only
works if that browser can reach Polymarket. From India it cannot: the ISP
resolver returns a sinkhole address for the entire polymarket.com zone
(measured: every hostname -> 2405:200:1607:2820:41::36, Airtel space, TCP 443
times out), while the real Cloudflare IPs answer HTTP 200 in 27ms. The block is
DNS-level, and it applies to the API subdomains, not just the website.

GitHub's runners are in the US and are unaffected -- which is why the scorecards
keep refreshing. So this module moves the trade feed to the same place: the
runner fetches it, commits it, and the static page serves it to everyone,
including visitors whose own network cannot reach Polymarket at all.

It is also a better match for the actual question. The raw firehose is ~28
fills/sec with a MEDIAN SIZE OF $2.40. Screened whales trade a few times an
hour. Polling their fills loses almost nothing and drops the noise entirely.
"""

from __future__ import annotations

import collections
import concurrent.futures as cf
import re
import sys
from typing import Any

from . import api

# Which wallets count as "the best whales" for the feed. FRAGILE is included
# deliberately -- it is a wallet with a real, measurable edge that carries a
# specific weakness, and watching it trade is informative. NOT COPYABLE and
# INSUFFICIENT are excluded: market makers alone would bury everything else.
FEED_VERDICTS = {"CANDIDATE", "WATCH", "FRAGILE"}

MAX_TRADES = 500          # rows kept in the committed JSON
PER_WALLET = 25           # recent fills pulled per wallet

# Same classification the frontend uses, kept in one place server-side so a
# whale's "trades mostly crypto/sports/..." tag agrees with what the trades
# feed shows for that same wallet -- two independent implementations of this
# regex would drift.
_CAT_PATTERNS = [
    ("crypto", re.compile(r"up or down|bitcoin|ethereum|solana|\bbtc\b|\beth\b|crypto", re.I)),
    ("sports", re.compile(r"\bvs\.?\b|win on 20|o/u|nba|nfl|mlb|ufc|atp|wta|premier league|"
                          r"match|\bfc\b", re.I)),
    ("macro", re.compile(r"fed|interest rate|cpi|inflation|gdp|recession|jobs", re.I)),
    ("politics", re.compile(r"trump|election|president|senate|congress|poll|nominee|"
                            r"war|ceasefire", re.I)),
]


def categorize(title: str, slug: str = "") -> str:
    s = f"{title or ''} {slug or ''}"
    for name, pat in _CAT_PATTERNS:
        if pat.search(s):
            return name
    return "other"


def _recent_trades(wallet: str, limit: int = PER_WALLET) -> list[dict]:
    """Recent fills for one wallet, via the v1 /trades endpoint.

    v1 is used on purpose: its payload is camelCase and field-for-field
    IDENTICAL to the websocket activity payload (proxyWallet / side / size /
    price / outcome / title / slug / timestamp / transactionHash), so the page
    parses live messages and this file with the same code.

    Both v1 and v2 are CDN-cached `max-age=300`, so there is no freshness to be
    gained from v2 here -- the earlier belief that v2 was uncached was a header
    misread (Cloudflare says DYNAMIC while CloudFront is the layer that caches).
    """
    try:
        rows = api._get(api.DATA, "/trades",
                        {"user": wallet, "limit": limit, "takerOnly": "false"})
    except api.PolymarketError as e:
        print(f"  ! trades {wallet}: {e}", file=sys.stderr)
        return []
    return rows if isinstance(rows, list) else (rows.get("data") or [])


def build_feed(cards: list[dict], *, workers: int = 8, log=print) -> tuple[dict[str, Any], dict[str, dict]]:
    """Given scored cards, return (committed feed object, per-wallet category profile).

    The category profile is a side effect of fetching the trades we need for the
    feed anyway -- pulling it a second time from build.py would double the API
    calls for no reason, so it is computed here and handed back for build.py to
    merge onto whales.json.
    """
    whales = [c for c in cards if c.get("verdict") in FEED_VERDICTS]
    by_wallet = {(c.get("wallet") or "").lower(): c for c in whales}
    log(f"  feed: pulling recent fills for {len(whales)} screened whales")

    out: list[dict] = []
    cats: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_recent_trades, c["wallet"]): c for c in whales}
        for fut in cf.as_completed(futs):
            card = futs[fut]
            wallet = (card["wallet"] or "").lower()
            for t in fut.result():
                ts = t.get("timestamp")
                if not ts:
                    continue
                size = float(t.get("size") or 0)
                price = float(t.get("price") or 0)
                title = t.get("title") or ""
                slug = t.get("slug") or t.get("eventSlug") or ""
                cats[wallet][categorize(title, slug)] += 1
                out.append({
                    "ts": int(ts),
                    "wallet": card["wallet"],
                    # prefer the name we already scored it under, so the feed and
                    # the board never disagree about who a wallet is
                    "name": card.get("name") or t.get("name") or t.get("pseudonym"),
                    "verdict": card.get("verdict"),
                    "net_dd": card.get("net_dd"),
                    "discovered": bool(card.get("discovered")),
                    "side": t.get("side"),
                    "size": round(size, 2),
                    "price": round(price, 4),
                    "usd": round(size * price, 2),
                    "outcome": t.get("outcome") or "",
                    "title": title,
                    "slug": slug,
                    "tx": t.get("transactionHash") or "",
                })

    # newest first, de-duplicated on the transaction+wallet+asset triple
    seen: set = set()
    uniq: list[dict] = []
    for t in sorted(out, key=lambda r: -r["ts"]):
        key = (t["tx"], t["wallet"], t["ts"], t["usd"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(t)
        if len(uniq) >= MAX_TRADES:
            break

    profiles: dict[str, dict] = {}
    for wallet, counter in cats.items():
        total = sum(counter.values())
        if total < 3:
            continue   # too few observed fills to call a category, don't guess
        top_cat, top_n = counter.most_common(1)[0]
        profiles[wallet] = {
            "category": top_cat,
            "category_confidence": round(top_n / total, 2),
            "category_breakdown": dict(counter),
            "sampled_fills": total,
        }

    newest = uniq[0]["ts"] if uniq else 0
    log(f"  feed: {len(uniq)} trades from {len({t['wallet'] for t in uniq})} whales, "
        f"{len(profiles)} category-tagged")
    feed = {
        "trades": uniq,
        "whales": len(by_wallet),
        "newest_ts": newest,
        "note": ("Server-side feed. Polled from a US runner because the live "
                 "browser socket is unreachable on networks where the "
                 "polymarket.com DNS zone is sinkholed. REST is CDN-cached "
                 "max-age=300, so these can be up to ~5 minutes behind."),
    }
    return feed, profiles
