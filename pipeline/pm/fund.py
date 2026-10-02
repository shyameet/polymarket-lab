"""PAPER FUND -- two $1,000 paper accounts that copy the proven whales by themselves.

WHY THIS EXISTS
---------------
The daily recap lists trades. The owner asked for the next step (2026-10-02): a
fund that "takes the best whale trades on its own, manages everything exactly as
the whale", so that at the end of a day or a week he can read what the money did
rather than what the whales did. Paper only -- nothing is ever sent to a market.

THE RULES, FIXED ON DAY ONE (the owner's choices that day)
-----------------------------------------------------------
* Money: $1,000 per fund. Every copy is the same $10 (1% of the start), never
  resized as the fund grows or shrinks.
* Signal: a "Worth following" whale's buys of one outcome on one India-time day
  reach $100. The fund copies at the fill that crossed $100, at the whale's own
  price ("same second", the best case). Every fill also records the market price
  one minute later, so what the timing is worth stays visible.
* One position per outcome: if the fund already holds it (another whale got there
  first), the new signal is skipped.
* Management follows the whale it copied: when that whale sells part of what the
  fund watched it buy, the fund sells the same fraction at the same price; when
  the market settles the fund is paid $1 or $0 a share, at the moment it closed,
  so the cash is there for the next signal. The whale adding more does not add to
  the copy -- one bet, one size.
* Cash: a copy needs $10 plus the fee. Without it the signal is counted as missed.
* Fees: taker fee rate * shares * p * (1 - p) on every buy and sell, none on a
  settlement payout (the same model as daily.py).
* Fund A copies every signal. Fund B copies only markets scheduled to end within
  48 hours, so its cash comes back and gets used again. (A scheduled end that has
  already passed while the market is still open counts as ending soon.)

NO LOOK-AHEAD
-------------
Each run replays the whales' fills since the previous run in time order, with the
whale list as it stood at the START of that window (saved by the previous run).
Settlements are events in the same timeline, at the moment each market closed.
The result is what a bot watching live would have done; it is just delivered every
few hours. The fund starts empty on the day it is switched on -- no backfill,
because a whale list chosen today would flatter a replay of the past.

A market pays out only once the replay has passed the moment it closed, so a whale
who sold minutes before the end is followed out, not held to $1 / $0.

WHAT IT CANNOT SEE
------------------
Only the buys it watched. If the whale already held the outcome from before, a
sale is read as a sale of what the fund watched it buy. Exits made by merging
both sides of a market instead of selling are not seen; the copy then holds to
the end.

THE MINUTE-LATE SHADOW
----------------------
The price a minute later comes from the CLOB price history (the price Polymarket
charts). In a 5-minute "Up or Down" market a minute is a fifth of the market's
life and that price can move 30c, so most of the gap between the two lines comes
from those markets; the per-topic table shows where.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import heapq
import json
import os
import sys
import threading
import time
from typing import Any, Callable

from . import api
from .daily import FEE_RATE, SOLD_OUT, _activity, ist_day, shift_day, token
from .feed import categorize

START_CASH = 1000.0
STAKE = 10.0
SIGNAL_USD = 100.0
LAG_S = 600              # replay only fills at least 10 minutes old: /activity indexes late
LATE_S = 60              # the "copied a minute late" shadow price
KEEP_CLOSED = 300        # closed trades kept in full per fund; the totals are kept for good
FUNDS = {"A": {"name": "Every bet", "max_hours": None},
         "B": {"name": "Ends within 2 days", "max_hours": 48}}
RULES = {"start_cash": START_CASH, "stake": STAKE, "signal_usd": SIGNAL_USD,
         "fee_rate": FEE_RATE, "late_s": LATE_S, "lag_s": LAG_S,
         "funds": {k: v["name"] for k, v in FUNDS.items()}}
DAY_KEYS = ("copied", "missed", "closed", "won", "realized", "base",
            "late", "late_n", "late_same", "fees")
CAT_KEYS = ("closed", "won", "realized", "late", "late_n", "late_same")


def fee(shares: float, price: float) -> float:
    return FEE_RATE * shares * price * (1.0 - price)


def iso_ts(s: str | None) -> int | None:
    if not s:
        return None
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def is_combo(condition: str, outcome: str, title: str) -> bool:
    """A parlay: synthetic condition id, or no single outcome and legs joined by AND."""
    return len(condition or "") != 66 or (not outcome and " AND " in (title or ""))


# ─────────────────────────── state ──────────────────────────────────────────

def new_state(now: int, whales: list[dict]) -> dict:
    # Copying starts the moment the whale list is taken, never before it: the
    # first window is (now, next run - LAG_S]. (The first live opening started
    # LAG_S earlier and copied three minutes of fills it had no list for yet.)
    return {"v": 1, "started": now, "cursor": now, "whales": whales,
            "episodes": {}, "seq": 0, "last_run": None,
            "funds": {k: {"cash": START_CASH, "open": [], "closed": [], "days": {}, "cats": {},
                          "points": [[now, START_CASH]], "missed_cash": 0,
                          "skipped_held": 0, "skipped_filter": 0} for k in FUNDS}}


def _bucket(table: dict, key: str, keys: tuple) -> dict:
    d = table.setdefault(key, {})
    for k in keys:
        d.setdefault(k, 0)
    return d


def _day(f: dict, ts: int) -> dict:
    return _bucket(f["days"], ist_day(ts), DAY_KEYS)


def _proceeds(p: dict) -> float:
    """Cash the copy has taken back through sales so far."""
    return sum(p["shares"] * s["frac"] * s["price"] - s["fee"] for s in p["sales"])


def _sell(f: dict, p: dict, ts: int, frac: float, price: float, late: float | None) -> None:
    sh = p["shares"] * frac
    fe = fee(sh, price)
    p["sales"].append({"ts": ts, "frac": frac, "price": price, "fee": fe, "late": late})
    p["left"] -= frac
    f["cash"] += sh * price - fe
    _day(f, ts)["fees"] += fe


def late_pnl(p: dict, payout: float | None) -> float | None:
    """The same trade copied a minute late at every step; None without the prices."""
    le = p.get("late_entry")
    if not le or not 0 < le < 1 or any(s["late"] is None for s in p["sales"]):
        return None
    sh = STAKE / le
    got = sum(sh * s["frac"] * s["late"] - fee(sh * s["frac"], s["late"]) for s in p["sales"])
    if payout is not None:
        got += sh * p["left"] * payout
    return got - STAKE - fee(sh, le)


def _close(f: dict, p: dict, ts: int, how: str, payout: float | None) -> None:
    rest = p["left"] if payout is not None else 0.0
    pnl = _proceeds(p) + p["shares"] * rest * (payout or 0.0) - STAKE - p["fee"]
    late = late_pnl(p, payout)
    # the no-skill chance of this result: the price paid if mostly held to the
    # end, a coin flip if mostly sold first (as in daily.py)
    baseline = p["price"] if (payout is not None and rest > 0.5) else 0.5
    for b in (_day(f, ts), _bucket(f["cats"], p["category"] or "other", CAT_KEYS)):
        b["closed"] += 1
        b["won"] += int(pnl > 0)
        b["realized"] += pnl
        if late is not None:
            b["late"] += late
            b["late_n"] += 1
            b["late_same"] += pnl
    _day(f, ts)["base"] += baseline
    sold = sum(s["frac"] for s in p["sales"])
    f["closed"].append({
        **{k: p.get(k) for k in ("id", "title", "slug", "outcome", "category", "whale", "whale_name",
                                 "ts", "price", "late_entry")},
        "close_ts": ts, "how": how, "payout": payout, "pnl": pnl, "late_pnl": late, "won": pnl > 0,
        "sold_frac": sold, "exit": sum(s["frac"] * s["price"] for s in p["sales"]) / sold if sold else None})
    f["open"].remove(p)


def _payout_at(p: dict, market: Callable, closed_at: Callable | None, until: int | None):
    """(when, payout) if this copy's market has settled at a moment inside the
    replayed window, else None."""
    if closed_at is None or until is None:
        return None
    m = market(p["condition"])
    tok = token(m, p["token"])
    if tok is None or not m.get("resolved"):
        return None
    t = closed_at(p["condition"])
    if t is None or t > until:
        return None
    return max(t, p["ts"]), 1.0 if tok["winner"] else 0.0


def step(state: dict, fills: list[dict], signal_wallets: set[str],
         market: Callable[[str], dict | None],
         price_later: Callable[[str, int], float | None],
         closed_at: Callable[[str], int | None] | None = None,
         until: int | None = None) -> int:
    """Replay whale fills, and the settlements inside the window, in time order
    through every fund. Mutates `state` and returns the number of signals seen.

    fills: /activity TRADE rows, each with `wallet` (and `name`) added.
    market(condition) -> {"tokens", "resolved", "end_ts"} or None.
    price_later(token, ts) -> the first price at or after ts, or None.
    closed_at(condition) -> when a settled market closed, or None. With `until`
    (the window's end) it lets a payout land at that moment, freeing the cash
    for later signals; without them, settle_and_mark pays out at the run's end.
    """
    funds = state["funds"]
    due: list[tuple] = []                          # (when, id, fund, payout)

    def schedule(code: str, p: dict) -> None:
        hit = _payout_at(p, market, closed_at, until)
        if hit:
            heapq.heappush(due, (hit[0], p["id"], code, hit[1]))

    def pay_until(ts: int) -> None:
        while due and due[0][0] < ts:
            t, pid, code, payout = heapq.heappop(due)
            f = funds[code]
            p = next((p for p in f["open"] if p["id"] == pid), None)
            if p is not None:                      # None: the whale sold it out first
                f["cash"] += p["shares"] * p["left"] * payout
                _close(f, p, t, "settled", payout)

    for code, f in funds.items():
        for p in list(f["open"]):
            schedule(code, p)

    eps = state["episodes"]
    signals = 0
    for r in sorted(fills, key=lambda r: (int(r["timestamp"]), r.get("side") != "BUY")):
        if r.get("type", "TRADE") != "TRADE":
            continue
        ts, side, w = int(r["timestamp"]), r.get("side"), r["wallet"]
        tok, size = str(r.get("asset") or ""), float(r.get("size") or 0)
        if not tok or size <= 0:
            continue
        pay_until(ts)
        usd = float(r.get("usdcSize") or 0) or size * float(r.get("price") or 0)
        price = float(r.get("price") or 0) or usd / size

        # every open copy follows the whale it copied, on that outcome only
        for f in funds.values():
            for p in [p for p in f["open"] if p["whale"] == w and p["token"] == tok]:
                if side == "BUY":
                    p["whale_held"] += size
                elif side == "SELL" and p["whale_held"] > 1e-9:
                    take = min(size, p["whale_held"])
                    frac = p["left"] * take / p["whale_held"]
                    p["whale_held"] -= take
                    if p["left"] - frac < SOLD_OUT:
                        frac = p["left"]
                    _sell(f, p, ts, frac, price, price_later(tok, ts + LATE_S))
                    if p["left"] <= 1e-9:
                        _close(f, p, ts, "sold", None)

        if side != "BUY" or w not in signal_wallets:
            continue
        cond, outcome, title = r.get("conditionId") or "", r.get("outcome") or "", r.get("title") or ""
        if is_combo(cond, outcome, title):
            continue
        ep = eps.setdefault(f"{w}|{tok}|{ist_day(ts)}", {"usd": 0.0, "shares": 0.0, "signaled": False})
        ep["usd"] += usd
        ep["shares"] += size
        if ep["signaled"] or ep["usd"] < SIGNAL_USD:
            continue
        ep["signaled"] = True
        if not 0.001 < price < 0.999:          # nothing left to win, or a dust print
            continue
        signals += 1
        m = market(cond) or {}
        for code, rule in FUNDS.items():
            f = funds[code]
            if any(p["token"] == tok for p in f["open"]):
                f["skipped_held"] += 1
                continue
            if rule["max_hours"] is not None:
                end = m.get("end_ts")
                if end is None or end - ts > rule["max_hours"] * 3600:
                    f["skipped_filter"] += 1
                    continue
            shares = STAKE / price
            fe = fee(shares, price)
            d = _day(f, ts)
            if f["cash"] < STAKE + fe:
                f["missed_cash"] += 1
                d["missed"] += 1
                continue
            f["cash"] -= STAKE + fe
            d["copied"] += 1
            d["fees"] += fe
            state["seq"] += 1
            slug = r.get("slug") or ""
            p = {"id": state["seq"], "token": tok, "condition": cond, "outcome": outcome,
                 "title": title, "slug": slug, "category": categorize(title, slug),
                 "whale": w, "whale_name": r.get("name") or "", "ts": ts, "price": price,
                 "shares": shares, "fee": fe, "whale_held": ep["shares"], "left": 1.0,
                 "sales": [], "late_entry": price_later(tok, ts + LATE_S), "end_ts": m.get("end_ts")}
            f["open"].append(p)
            schedule(code, p)
    if until is not None:
        pay_until(until + 1)
    return signals


def settle_and_mark(state: dict, market: Callable[[str], dict | None], now: int,
                    closed_at: Callable[[str], int | None] | None = None) -> int:
    """Pay out settled markets the replay has passed, mark the rest at the current
    price, record equity. Returns the number of positions settled here.

    step() already pays out every market whose close falls inside the window it
    replayed. What is left: a market whose close time is unknown pays out on the
    run after the one that first saw it settled (by then the replay has passed
    that moment), and one that closed after the replayed window waits.
    """
    cursor = state["cursor"]
    settled = 0
    for f in state["funds"].values():
        for p in list(f["open"]):
            m = market(p["condition"])
            tok = token(m, p["token"])
            if tok is None:
                continue
            if not m.get("resolved"):
                p["mark"] = tok["price"]
                continue
            payout = 1.0 if tok["winner"] else 0.0
            p["mark"] = payout
            p.setdefault("resolved_seen", now)
            t = closed_at(p["condition"]) if closed_at else None
            if not ((t is not None and t <= cursor) or p["resolved_seen"] <= cursor):
                continue
            last = max([p["ts"]] + [s["ts"] for s in p["sales"]])
            f["cash"] += p["shares"] * p["left"] * payout
            _close(f, p, max(last, t if t is not None else p["resolved_seen"]), "settled", payout)
            settled += 1
    for f in state["funds"].values():
        value = sum(p["shares"] * p["left"] * p.get("mark", p["price"]) for p in f["open"])
        f["points"].append([now, round(f["cash"] + value, 4)])
        f["closed"] = sorted(f["closed"], key=lambda c: c["close_ts"])[-KEEP_CLOSED:]
    keep_from = shift_day(ist_day(now), -1)
    state["episodes"] = {k: v for k, v in state["episodes"].items() if k.rsplit("|", 1)[1] >= keep_from}
    return settled


# ─────────────────────────── the published view ─────────────────────────────

def _r(v: float | None, n: int = 2) -> float | None:
    return None if v is None else round(v, n)


def _value(p: dict) -> float:
    return p["shares"] * p["left"] * p.get("mark", p["price"])


def _rounded(row: dict) -> dict:
    return {k: _r(v) if isinstance(v, float) else v for k, v in row.items()}


def view(state: dict, now: int) -> dict:
    out = {"generated_at": now, "started": state["started"], "cursor": state["cursor"],
           "last_run": state.get("last_run"), "rules": RULES, "funds": {}}
    for code, f in state["funds"].items():
        pts = f["points"]
        peak, dd = START_CASH, 0.0
        for _, v in pts:
            peak = max(peak, v)
            dd = max(dd, peak - v)
        tot = {k: sum(d.get(k, 0) for d in f["days"].values()) for k in DAY_KEYS}
        eq_day: dict[str, float] = {}
        for ts, v in pts:
            eq_day[ist_day(ts)] = v
        days, prev = [], START_CASH
        for d in sorted(set(f["days"]) | set(eq_day)):
            row = {"date": d, **_rounded(f["days"].get(d, {}))}
            if d in eq_day:
                row["equity"], row["change"] = _r(eq_day[d]), _r(eq_day[d] - prev)
                prev = eq_day[d]
            days.append(row)
        open_rows = []
        for p in sorted(f["open"], key=lambda p: -p["ts"]):
            sold = sum(s["frac"] for s in p["sales"])
            open_rows.append({
                **{k: p.get(k) for k in ("id", "title", "slug", "outcome", "category", "whale",
                                         "whale_name", "ts", "end_ts")},
                "price": _r(p["price"], 4), "late_entry": _r(p.get("late_entry"), 4),
                "mark": _r(p.get("mark"), 4), "sold_frac": _r(sold, 4),
                "exit": _r(sum(s["frac"] * s["price"] for s in p["sales"]) / sold, 4) if sold else None,
                "value": _r(_value(p)), "pnl_now": _r(_value(p) + _proceeds(p) - STAKE - p["fee"]),
                "settling": "resolved_seen" in p})
        closed_rows = [{**c, "price": _r(c["price"], 4), "late_entry": _r(c.get("late_entry"), 4),
                        "pnl": _r(c["pnl"]), "late_pnl": _r(c["late_pnl"]),
                        "sold_frac": _r(c["sold_frac"], 4), "exit": _r(c["exit"], 4)}
                       for c in sorted(f["closed"], key=lambda c: -c["close_ts"])]
        cats = sorted(({"category": k, **_rounded(v)} for k, v in f["cats"].items()),
                      key=lambda c: -c["closed"])
        unreal = sum(r["pnl_now"] for r in open_rows)
        out["funds"][code] = {
            "name": FUNDS[code]["name"], "start": START_CASH, "equity": _r(pts[-1][1]),
            "pnl": _r(pts[-1][1] - START_CASH), "cash": _r(f["cash"]),
            "realized": _r(tot["realized"]), "unrealized": _r(unreal),
            "open_n": len(f["open"]), "in_bets": _r(sum(_value(p) for p in f["open"])),
            "closed_n": tot["closed"], "won": tot["won"], "lost": tot["closed"] - tot["won"],
            "win_rate": _r(tot["won"] / tot["closed"], 4) if tot["closed"] else None,
            "baseline": _r(tot["base"] / tot["closed"], 4) if tot["closed"] else None,
            "late_pnl": _r(tot["late"]) if tot["late_n"] else None, "late_n": tot["late_n"],
            "late_same": _r(tot["late_same"]) if tot["late_n"] else None,
            "copied": tot["copied"], "missed_cash": f["missed_cash"],
            "skipped_held": f["skipped_held"], "skipped_filter": f["skipped_filter"],
            "fees": _r(tot["fees"]), "max_dd": _r(dd),
            "points": [[t, _r(v)] for t, v in pts[-600:]],
            "days": days[::-1], "cats": cats, "open": open_rows, "closed": closed_rows,
        }
    return out


# ─────────────────────────── fetching ───────────────────────────────────────

class _Pace:
    """At most `rate` request starts per second, shared by every thread. The CLOB
    answered eight unpaced threads with HTTP 429 (verified 2026-10-02)."""

    def __init__(self, rate: float):
        self.gap, self.next, self.lock = 1.0 / rate, 0.0, threading.Lock()

    def __call__(self) -> None:
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next)
            self.next = at + self.gap
        if at > now:
            time.sleep(at - now)


_CLOB_PACE, _GAMMA_PACE = _Pace(10), _Pace(5)


class _Lookups:
    """Memoised API lookups with a failure budget, so a bad API day costs
    minutes, not the job's whole time limit. A rate-limit answer (429) is waited
    out rather than counted: a missing market would skew the book (fund B skips
    a market it cannot date), so it is worth the wait."""

    def __init__(self, fn: Callable, budget: int = 12):
        self.fn, self.budget, self.fails, self.cache = fn, budget, 0, {}

    def __call__(self, *key):
        if key in self.cache:
            return self.cache[key]
        for attempt in range(4):
            if self.fails >= self.budget:
                return None
            try:
                v = self.fn(*key)
                break
            except api.PolymarketError as e:
                if "429" in str(e) and attempt < 3:
                    time.sleep(4 * 2 ** attempt)
                    continue
                self.fails += 1
                print(f"  ! fund lookup {getattr(self.fn, '__name__', 'api')}{key}: {e}", file=sys.stderr)
                return None
        self.cache[key] = v
        return v

    def peek(self, want: set) -> Callable:
        """A stand-in that answers from the cache and notes what it lacks."""
        def look(*key):
            if key not in self.cache:
                want.add(key)
            return self.cache.get(key)
        return look

    def prefetch(self, keys, workers: int) -> None:
        todo = [k for k in dict.fromkeys(keys) if k not in self.cache]
        if todo:
            with cf.ThreadPoolExecutor(max_workers=workers) as ex:
                list(ex.map(lambda k: self(*k), todo))


def _clob_market(cid: str) -> dict | None:
    _CLOB_PACE()
    m = api._get(api.CLOB, f"/markets/{cid}", retries=2, timeout=20)
    toks = {str(t.get("token_id")): {"price": float(t.get("price") or 0), "winner": bool(t.get("winner"))}
            for t in (m.get("tokens") or []) if t.get("token_id")}
    if not toks:
        return None
    return {"tokens": toks, "end_ts": iso_ts(m.get("end_date_iso")),
            "resolved": bool(m.get("closed")) and any(t["winner"] for t in toks.values())}


def _price_later(tok: str, ts: int) -> float | None:
    _CLOB_PACE()
    h = api._get(api.CLOB, "/prices-history", {"market": tok, "startTs": ts - 60, "endTs": ts + 1800,
                                               "fidelity": 1}, retries=2, timeout=20)
    for pt in (h or {}).get("history") or []:
        if int(pt.get("t") or 0) >= ts:
            return float(pt["p"])
    return None


def _closed_at(cid: str) -> int | None:
    """When a market closed, from Gamma. closed=true is required (feed._end_dates:
    a settled market vanishes from closed=false filters)."""
    _GAMMA_PACE()
    for m in api.markets_keyset(limit=1, closed=True, max_pages=1, condition_ids=[cid]):
        if m.get("conditionId") == cid:
            return iso_ts(m.get("closedTime"))
    return None


# ─────────────────────────── one pipeline run ───────────────────────────────

def _replay(state: dict, fills: list[dict], signal: set[str], until: int, now: int,
            market: _Lookups, closed: _Lookups, later: _Lookups, workers: int) -> tuple[int, int]:
    """step() + settle_and_mark(), after dry runs that learn which lookups the
    window needs and fetch them in parallel. The dry runs repeat because the
    answers change the path: a payout frees cash, the cash opens another copy."""
    for _ in range(4):
        wm, wc, wl = set(), set(), set()
        trial = json.loads(json.dumps(state))
        step(trial, fills, signal, market.peek(wm), later.peek(wl), closed.peek(wc), until)
        settle_and_mark(trial, market.peek(wm), now, closed.peek(wc))
        if not (wm or wc or wl):
            break
        for lookups, keys in ((market, wm), (closed, wc), (later, wl)):
            lookups.prefetch(keys, workers)
    signals = step(state, fills, signal, market, later, closed, until)
    return signals, settle_and_mark(state, market, now, closed)


def build_fund(cards: list[dict], *, now_ts: int, out_dir: str, workers: int = 8,
               log=print) -> dict[str, Any]:
    whales_now = [{"wallet": (c.get("wallet") or "").lower(), "name": c.get("name") or ""}
                  for c in cards if c.get("verdict") == "CANDIDATE" and c.get("wallet")]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "state.json")
    try:
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = None

    if state is None:
        state = new_state(now_ts, whales_now)
        log(f"  fund: opened two ${START_CASH:,.0f} paper funds, following {len(whales_now)} whales")
    else:
        start, until = state["cursor"], now_ts - LAG_S
        signal = {w["wallet"] for w in state["whales"]}
        names = {w["wallet"]: w["name"] for w in state["whales"]}
        holding = {p["whale"] for f in state["funds"].values() for p in f["open"]}
        follow = sorted(signal | holding)
        fills: list[dict] = []
        failed: list[str] = []
        cut = 0
        if until > start:
            with cf.ThreadPoolExecutor(max_workers=workers) as ex:
                futs = {ex.submit(_activity, w, start + 1, until): w for w in follow}
                for fut in cf.as_completed(futs):
                    w = futs[fut]
                    try:
                        rows, truncated = fut.result()
                    except api.PolymarketError as e:
                        failed.append(w)
                        print(f"  ! fund activity {w}: {e}", file=sys.stderr)
                        continue
                    cut += truncated
                    fills.extend({**r, "wallet": w, "name": names.get(w) or r.get("name") or ""}
                                 for r in rows if r.get("type") == "TRADE")
        # Exits matter more than entries: never step past a window in which a whale
        # the funds hold could not be read. A few unreadable signal-only whales are
        # tolerated (their entries in this window are simply not seen).
        if any(w in holding for w in failed) or len(failed) > 3:
            log(f"  ! fund: {len(failed)} whales unreadable; this window is replayed next run")
            fills, until = [], start
        moved = until > start
        if moved:
            state["cursor"] = until
        signals, settled = _replay(state, fills, signal, state["cursor"], now_ts,
                                   _Lookups(_clob_market), _Lookups(_closed_at),
                                   _Lookups(_price_later), workers)
        if moved:
            state["whales"] = whales_now
        state["last_run"] = {"at": now_ts, "from": start, "to": state["cursor"], "fills": len(fills),
                             "signals": signals, "whales": len(follow), "failed": len(failed),
                             "truncated": cut}
        log(f"  fund: replayed {len(fills)} whale fills ({signals} signals) from {len(follow)} whales, "
            + ", ".join(f"{k} ${state['funds'][k]['points'][-1][1]:,.2f} "
                        f"({len(state['funds'][k]['open'])} open)" for k in FUNDS)
            + f", {settled} paid out at the end of the run")

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(out_dir, "fund.json"), "w", encoding="utf-8") as fh:
        json.dump(view(state, now_ts), fh, separators=(",", ":"), ensure_ascii=False)
    return {k: _r(state["funds"][k]["points"][-1][1]) for k in FUNDS}
