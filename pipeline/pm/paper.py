"""Paper copy-trader with latency injection — the decay-vs-delay curve.

THE ONE NUMBER THIS EXISTS TO PRODUCE
-------------------------------------
Realized follower edge as a function of how late you are. Where that curve
crosses zero decides whether copying Polymarket whales is a strategy or a story.
Nobody has published it: the single public copier experiment is n=2 wallets with
paper fills, and it measured +$171 on $10,000 over six weeks at t=1.53 -- which
is indistinguishable from nothing, and was fee-blind despite running entirely
inside the fee era.

HOW FILLS ARE SIMULATED, AND WHY THE ANSWER IS A LOWER BOUND ON COST
--------------------------------------------------------------------
Historical order-book depth for Polymarket is not freely available, so this does
NOT walk a book. When a tracked whale fills at time t, the simulator takes the
next price actually PRINTED in that same outcome token at or after t + delay,
and fills there.

That is a real, defensible price -- somebody genuinely transacted at it -- but it
is optimistic in one specific, knowable way: YOUR OWN ORDER IS NOT IN THE BOOK.
A real follower's order consumes depth and pushes the price further against
itself, and if several followers copy the same whale they collide. So every
result here is a LOWER BOUND ON COST and an UPPER BOUND ON RETURNS. If the curve
is already negative at a given delay, the real thing is worse and the question is
settled. If it is positive, it is NOT yet evidence of edge -- it is a ceiling,
and the next step is depth reconstruction.

This asymmetry is the point: the cheap version can only ever KILL the idea, never
confirm it. That is still worth having, because killing it cheaply is the most
valuable outcome available.

FEES ARE NOT OPTIONAL HERE
--------------------------
Polymarket's taker fee has applied since 2026-03-30 and is roughly
    fee = rate * shares * p * (1 - p)
which at p = 0.5 is about 2.0-2.4% OF NOTIONAL PER SIDE. A follower is a taker by
construction on every leg, entry and exit. Two legs of that is a ~4-5% round-trip
hurdle before any edge. Running this fee-blind is the single easiest way to
manufacture a strategy that does not exist.
"""

from __future__ import annotations

import argparse
import collections
import json
import statistics
from typing import Any, Iterable

from .chain import PolygonClient, fills as chain_fills

# Taker fee rate. Category-dependent in reality (~0.04-0.07; geopolitics has been
# free). 0.05 is the middle. fee = rate * shares * p * (1-p).
DEFAULT_FEE_RATE = 0.05

# If no print appears in the token within this long after our intended entry,
# the signal is recorded as MISSED rather than filled at a stale price.
FILL_TIMEOUT_S = 1800


def fee_usd(shares: float, price: float, rate: float = DEFAULT_FEE_RATE) -> float:
    """Polymarket-style taker fee. Zero at the extremes, maximal at p=0.5."""
    return rate * shares * price * (1.0 - price)


class Tape:
    """Fills indexed for replay: chronological, and grouped per token."""

    def __init__(self, rows: Iterable[dict]):
        self.rows = sorted(rows, key=lambda r: (r.get("ts") or r["block"], r["log_index"]))
        self.by_token: dict[str, list] = collections.defaultdict(list)
        for r in self.rows:
            self.by_token[r["token_id"]].append(r)

    def price_at_or_after(self, token_id: str, ts: int) -> tuple[float, int] | None:
        """The next price actually printed in this token at or after `ts`."""
        seq = self.by_token.get(token_id) or []
        for r in seq:
            rt = r.get("ts") or 0
            if rt >= ts:
                if rt - ts > FILL_TIMEOUT_S:
                    return None
                return r["price"], rt
        return None


def simulate(tape: Tape, tracked: set[str], *, delay_s: int,
             stake_usd: float = 100.0, fee_rate: float = DEFAULT_FEE_RATE,
             hold_s: int = 3600) -> dict:
    """Mirror every tracked-wallet fill after `delay_s`, exit after `hold_s`.

    A fixed holding time is deliberate for v1: exit-mirroring introduces a second
    set of assumptions (the leader trims 40%, do you? their exit is itself a
    signal you also receive late) and would confound the delay measurement. Hold
    time is a parameter to sweep separately, not a free choice to tune.
    """
    trades: list[dict] = []
    missed = 0

    for r in tape.rows:
        # The whale's own side: we mirror the wallet that INITIATED, i.e. took.
        # A maker fill is the whale being hit, not the whale acting.
        actor = r["taker"]
        if actor not in tracked:
            continue
        t0 = r.get("ts") or 0
        if not t0:
            continue

        entry = tape.price_at_or_after(r["token_id"], t0 + delay_s)
        if entry is None:
            missed += 1
            continue
        ep, ets = entry
        exit_ = tape.price_at_or_after(r["token_id"], ets + hold_s)
        if exit_ is None:
            missed += 1
            continue
        xp, xts = exit_

        shares = stake_usd / ep if ep > 0 else 0.0
        if shares <= 0:
            continue

        # direction: the whale's fill side, mirrored
        long = (r["side"] == "BUY")
        gross = shares * ((xp - ep) if long else (ep - xp))
        f = fee_usd(shares, ep, fee_rate) + fee_usd(shares, xp, fee_rate)

        trades.append({
            "wallet": actor, "token": r["token_id"], "side": r["side"],
            "whale_price": r["price"], "entry": ep, "exit": xp,
            "slip": round(ep - r["price"], 6) * (1 if long else -1),
            "shares": round(shares, 4),
            "gross": round(gross, 4), "fees": round(f, 4),
            "net": round(gross - f, 4),
            "entry_lag_s": ets - t0, "held_s": xts - ets,
        })

    return summarise(trades, missed, delay_s, stake_usd, fee_rate)


def summarise(trades: list[dict], missed: int, delay_s: int,
              stake: float, fee_rate: float) -> dict:
    if not trades:
        return {"delay_s": delay_s, "trades": 0, "missed": missed,
                "net": 0.0, "gross": 0.0, "fees": 0.0, "max_dd": 0.0,
                "net_dd": None, "win_rate": None, "avg_slip": None, "rows": []}

    eq, peak, dd = 0.0, 0.0, 0.0
    for t in trades:
        eq += t["net"]
        peak = max(peak, eq)
        dd = max(dd, peak - eq)

    gross = sum(t["gross"] for t in trades)
    fees = sum(t["fees"] for t in trades)
    net = gross - fees
    wins = sum(1 for t in trades if t["net"] > 0)
    return {
        "delay_s": delay_s,
        "trades": len(trades),
        "missed": missed,
        "gross": round(gross, 2),
        "fees": round(fees, 2),
        "net": round(net, 2),
        "net_per_trade": round(net / len(trades), 4),
        "max_dd": round(dd, 2),
        "net_dd": round(net / dd, 2) if dd > 0 else None,
        "win_rate": round(wins / len(trades), 4),
        "avg_slip": round(statistics.mean(t["slip"] for t in trades), 5),
        "fee_share_of_gross": round(fees / abs(gross), 3) if gross else None,
        "stake": stake, "fee_rate": fee_rate,
        "rows": trades,
    }


def decay_curve(tape: Tape, tracked: set[str], delays: list[int], **kw) -> list[dict]:
    """The deliverable: net edge and drawdown as a function of latency."""
    out = []
    for d in delays:
        r = simulate(tape, tracked, delay_s=d, **kw)
        r.pop("rows", None)
        out.append(r)
    return out


def load_tracked(path: str, *, verdicts=("CANDIDATE", "WATCH")) -> set[str]:
    cards = json.load(open(path, encoding="utf-8"))
    keep = set()
    for c in cards:
        if c.get("verdict") not in verdicts:
            continue
        if c.get("onchain_verdict") == "UNREACHABLE":
            continue
        keep.add((c.get("wallet") or "").lower())
    return keep


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", type=int, default=3000,
                    help="how many recent blocks of tape to replay")
    ap.add_argument("--delays", default="0,30,120,300,900",
                    help="seconds of follower latency to test")
    ap.add_argument("--stake", type=float, default=100.0)
    ap.add_argument("--hold", type=int, default=3600)
    ap.add_argument("--fee-rate", type=float, default=DEFAULT_FEE_RATE)
    ap.add_argument("--whales", default="../docs/data/whales.json")
    ap.add_argument("--all-wallets", action="store_true",
                    help="ignore the screen; mirror every wallet (population baseline)")
    ap.add_argument("--rpc", default=None, help="keyed RPC URL for wider scans")
    args = ap.parse_args()

    c = PolygonClient([args.rpc] if args.rpc else ["https://polygon.drpc.org"])
    head = c.block_number()
    lo = head - args.blocks + 1
    print(f"replaying blocks {lo:,}..{head:,} ({args.blocks} blocks, "
          f"~{args.blocks*2.1/60:.0f} min of tape)")

    rows: list[dict] = []
    step = 100
    for b in range(lo, head + 1, step):
        try:
            rows.extend(chain_fills(c, b, min(b + step - 1, head)))
        except Exception as e:  # noqa: BLE001
            print(f"  ! {b}: {str(e)[:60]}")
    # block timestamps: one call per distinct block is too many, so approximate
    # from block height. Polygon is ~2.1s/block and this only needs to be
    # consistent, since every measurement here is a DIFFERENCE of two times.
    for r in rows:
        r["ts"] = int((r["block"] - lo) * 2.1)
    print(f"  {len(rows)} fills, {len({r['token_id'] for r in rows})} tokens, "
          f"{len({r['taker'] for r in rows})} taking wallets")

    tape = Tape(rows)
    if args.all_wallets:
        tracked = {r["taker"] for r in rows}
        label = "ALL wallets (population baseline)"
    else:
        tracked = load_tracked(args.whales)
        label = f"{len(tracked)} screened wallets"
    print(f"  mirroring: {label}")

    delays = [int(x) for x in args.delays.split(",")]
    curve = decay_curve(tape, tracked, delays, stake_usd=args.stake,
                        hold_s=args.hold, fee_rate=args.fee_rate)

    print(f"\n{'delay':>7}{'trades':>8}{'gross':>10}{'fees':>9}{'net':>10}"
          f"{'net/trade':>11}{'maxDD':>9}{'Net/DD':>8}{'win%':>7}{'slip':>9}")
    print("-" * 88)
    for r in curve:
        nd = f"{r['net_dd']:.2f}" if r["net_dd"] is not None else "-"
        wr = f"{r['win_rate']*100:.0f}" if r["win_rate"] is not None else "-"
        sl = f"{r['avg_slip']:+.4f}" if r["avg_slip"] is not None else "-"
        print(f"{r['delay_s']:>6}s{r['trades']:>8}{r['gross']:>10.2f}{r['fees']:>9.2f}"
              f"{r['net']:>10.2f}{r['net_per_trade']:>11.4f}{r['max_dd']:>9.2f}"
              f"{nd:>8}{wr:>7}{sl:>9}")
    print("\nREMINDER: no market impact is modelled, so these are an UPPER BOUND on\n"
          "returns. A negative row is conclusive; a positive row is a ceiling only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
