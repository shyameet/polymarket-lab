"""On-chain behavioural screen: is this wallet's edge REACHABLE by a follower?

The PnL screen in score.py asks whether a wallet is good. This asks a different
and more decisive question: could you get their prices at all?

THE MAKER PROBLEM
-----------------
A maker posts a resting order and waits; a taker crosses the spread. If a whale
is a maker, their fill exists BECAUSE they were patient and had queue priority.
You cannot have their price — posting behind them in the queue does not
reproduce it, and to get in at all you must cross and pay the offer. So you pay
more than they did on every trade, and part of their edge WAS that spread. Then
you also pay Polymarket's taker fee (~2.0-2.4% of notional at p=0.5) which they
avoided or earned as a rebate. Double penalty on a trade whose edge was the
spread itself.

A taker's edge is directional. You are in the same game, later and worse — a
measurable penalty, not a structural impossibility.

MEASURED DISTRIBUTION (36,562 fills, 600 blocks, 2,007 wallets with >=5 fills):
it is BIMODAL. A dense mass of two-sided traders at 40-60% maker, a near-empty
valley, and a hard spike of 490 wallets (24%) at EXACTLY 100% maker who never
cross the spread. The gate sits at 60% because 60->70 changes almost nothing
(64.5% vs 68.6% kept) — a plateau — while 40% is a cliff into the dense bucket
that leaves a single survivor. Pick the middle of the plateau, not the edge of
the cliff.

SAMPLING
--------
Scanning one wallet's full history needs ~3,000 RPC calls at the public 100-block
cap. Instead this scans the TAPE in stratified windows and buckets every wallet
at once: one pass characterises thousands of wallets. Coverage is a sample, not a
census, so a wallet's maker-share here is an ESTIMATE with sampling error — which
is why `min_fills` exists and why wallets below it are reported as UNKNOWN rather
than given a number that looks precise.

With a keyed RPC (free Alchemy/Infura), raise `window` and `windows` for a real
census.
"""

from __future__ import annotations

import collections
import statistics
from typing import Any

from .chain import PolygonClient, EXCHANGES, decode_fill

# --- the gates, as decided -------------------------------------------------

MAKER_GATE = 0.60          # reject wallets making on more than this share of fills
MACHINE_FILLS_PER_DAY = 500  # above this you cannot react at ~2s block latency
DUST_MEDIAN_USD = 10.0     # FLAG only -- gating here filters on size, not skill
MIN_FILLS_TO_JUDGE = 5     # below this the maker-share ratio is noise

BLOCKS_PER_DAY = 41_000    # Polygon ~2.1s blocks


def scan_tape(client: PolygonClient | None = None, *, days: float = 7.0,
              windows: int = 24, window: int = 100, log=print) -> dict[str, dict]:
    """Stratified scan of the fill tape; returns per-wallet behaviour.

    Samples `windows` evenly-spaced blocks of `window` blocks each across the
    last `days`. Every wallet seen in any window is characterised at once.
    """
    c = client or PolygonClient(["https://polygon.drpc.org"])
    head = c.block_number()
    span = int(days * BLOCKS_PER_DAY)
    start = head - span
    step = max(window, span // max(windows, 1))

    mk: collections.Counter = collections.Counter()
    tk: collections.Counter = collections.Counter()
    sizes: dict[str, list] = collections.defaultdict(list)
    markets: dict[str, set] = collections.defaultdict(set)
    first_seen: dict[str, int] = {}
    last_seen: dict[str, int] = {}
    venue_addrs = {a.lower() for a in EXCHANGES}

    total = 0
    for i in range(windows):
        lo = start + i * step
        hi = min(lo + window - 1, head)
        if lo > head:
            break
        for addr in EXCHANGES:
            try:
                logs = c.logs(lo, hi, address=addr)
            except Exception as e:  # noqa: BLE001 - a bad window must not kill the scan
                log(f"    ! window {lo}-{hi} {addr[:10]}: {str(e)[:60]}")
                continue
            for lg in logs:
                t = decode_fill(lg)
                if not t:
                    continue
                total += 1
                for who, counter in ((t["maker"], mk), (t["taker"], tk)):
                    if who in venue_addrs:
                        continue           # the venue standing in for the aggressor
                    counter[who] += 1
                    sizes[who].append(t["usd"])
                    markets[who].add(t["token_id"])
                    b = t["block"]
                    first_seen[who] = min(first_seen.get(who, b), b)
                    last_seen[who] = max(last_seen.get(who, b), b)
        if (i + 1) % 6 == 0:
            log(f"    window {i+1}/{windows}: {total} fills, {len(mk) + len(tk)} wallets")

    # sampled fraction: we only looked at `windows * window` of `span` blocks
    covered = min(windows, max(1, span // step)) * window
    frac = covered / span if span else 1.0

    out: dict[str, dict] = {}
    for w in set(mk) | set(tk):
        m, t = mk[w], tk[w]
        n = m + t
        sz = sizes[w]
        # scale the observed count up by the sampled fraction to get a rate
        seen_days = max(days * frac, 1e-9)
        out[w] = {
            "fills_sampled": n,
            "maker": m,
            "taker": t,
            "maker_share": (m / n) if n else None,
            "median_usd": round(statistics.median(sz), 2) if sz else 0.0,
            "total_usd": round(sum(sz), 2),
            "markets": len(markets[w]),
            "fills_per_day_est": round(n / seen_days, 1),
            "last_block": last_seen.get(w),
            "judged": n >= MIN_FILLS_TO_JUDGE,
        }
    log(f"  scanned {total} fills across {windows} windows "
        f"({frac:.2%} of the last {days:g}d); {len(out)} wallets characterised")
    return out


def apply_screen(card: dict, beh: dict | None, *, head_block: int | None = None) -> dict:
    """Merge on-chain behaviour into a scorecard and apply the gates.

    Adds `onchain_*` fields, appends flags, and can force the verdict to
    NOT COPYABLE. Returns the same dict, mutated.
    """
    card["onchain"] = beh or None
    if not beh or not beh.get("judged"):
        card.setdefault("flags", []).append(
            "NO ON-CHAIN SAMPLE: not seen often enough in the sampled tape to judge "
            "reachability -- maker-share unknown, not assumed good")
        card["onchain_verdict"] = "UNKNOWN"
        return card

    flags = card.setdefault("flags", [])
    share = beh["maker_share"]
    rate = beh["fills_per_day_est"]
    reject = False

    # --- GATE 1: maker-share --------------------------------------------
    if share is not None and share > MAKER_GATE:
        reject = True
        flags.append(
            f"UNREACHABLE PRICES: makes on {share:.0%} of fills (gate {MAKER_GATE:.0%}). "
            f"A resting order's price cannot be copied -- you would cross the spread "
            f"they earned, and pay the taker fee they avoided")

    # --- GATE 2: machine-rate -------------------------------------------
    if rate > MACHINE_FILLS_PER_DAY:
        reject = True
        flags.append(
            f"MACHINE RATE: ~{rate:,.0f} fills/day. At ~2s block latency you cannot "
            f"react to this regardless of whether it is skilled")

    # --- FLAG (not gate): dust ------------------------------------------
    if beh["median_usd"] < DUST_MEDIAN_USD:
        flags.append(
            f"DUST SIZE: median fill ${beh['median_usd']:,.2f}. Not gated -- small can "
            f"still be skilled -- but conviction is unreadable at this size")

    # --- FLAG (not gate): single-market ---------------------------------
    if beh["markets"] <= 2 and beh["fills_sampled"] >= 20:
        flags.append(
            f"NARROW: all sampled activity in {beh['markets']} market(s). Specialisation, "
            f"not necessarily a defect -- but it is one market's worth of evidence")

    card["onchain_verdict"] = "UNREACHABLE" if reject else "REACHABLE"
    if reject:
        card["verdict"] = "NOT COPYABLE"
        card["rankable"] = False
    return card


def screen_cards(cards: list[dict], behaviour: dict[str, dict], *, log=print) -> dict:
    """Apply the screen to a whole board. Returns a summary."""
    before = collections.Counter(c["verdict"] for c in cards)
    judged = reached = 0
    for c in cards:
        beh = behaviour.get((c.get("wallet") or "").lower())
        apply_screen(c, beh)
        if c["onchain_verdict"] != "UNKNOWN":
            judged += 1
            reached += c["onchain_verdict"] == "REACHABLE"
    after = collections.Counter(c["verdict"] for c in cards)
    summary = {
        "judged": judged,
        "reachable": reached,
        "unreachable": judged - reached,
        "verdicts_before": dict(before),
        "verdicts_after": dict(after),
        "maker_gate": MAKER_GATE,
        "machine_fills_per_day": MACHINE_FILLS_PER_DAY,
    }
    log(f"  on-chain screen: {judged} wallets judged, {reached} reachable, "
        f"{judged - reached} rejected as unreachable")
    return summary
