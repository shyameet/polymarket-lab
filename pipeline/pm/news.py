"""NEWS -- the macro-news board, its biggest wallets, and a $1,000 paper copy of them.

WHY THIS EXISTS
---------------
The owner asked (2026-11-10) for one place that answers, for each upcoming news
release that Polymarket prices (central-bank decisions, US data): what does the
crowd expect, which instruments does the news move, what are the biggest wallets
holding and at what price, and what would $1,000 copying those wallets really
have made -- "realistic, honest, based on the real spread of Polymarket's fills".

THE BOARD
---------
Open events on Polymarket that settle on one scheduled release: a single meeting
of a central bank, or one US data print (CPI, jobs, PCE, ...). The release time is
the bank's or agency's published local time on the scheduled day (the day from
the market's own rules text, else its end date). Each event lists the crowd's odds
and the 10 wallets with the most money in it right now (shares x current price,
summed over all its outcomes), with their average entry price from /v2/holders.

THE COPY ACCOUNT (the owner's choices, 2026-11-10)
--------------------------------------------------
* Forward only: it opens empty on its first run, with no back-test.
* Who: the 10 biggest wallets of each event, as listed by the PREVIOUS run (no
  look-ahead: a wallet becomes copyable only after it was seen at the top).
* Signal: one of them buys $100 or more of one outcome in one India-time day.
* Size: $25 flat, never resized. One position per outcome.
* Price -- the honest part. The whale's own price is not available to a copier.
  The copy buys from the fills that really happened after the whale's: the
  takers who bought the same outcome after it (they paid the ask), in time order,
  starting in the same second, until $25 is filled. The price paid is their
  volume-weighted price, plus the market's taker fee on each piece. If less than
  $25 traded in the 5 minutes after, the signal is counted as missed for lack of
  liquidity: a copy can only be as big as what really traded.
* Exit: follows the whale it copied. When that whale sells part of what it was
  seen buying, the copy sells the same fraction into the takers who sold after it
  (they hit the bid), the same way; what found no buyer within 5 minutes stays
  held. Otherwise it holds and is paid $1 / $0 a share when the market settles.
* An open copy is valued at what it would sell for right now: its shares walked
  through the buy orders really waiting, less the fee.

WHAT IT CANNOT SEE
------------------
Order books of the past are not published, only fills. Walking later fills
assumes the copy takes the place of those takers; a real order would also move
the price for whoever came next, so the cost is, if anything, understated for a
thin market. A fill in the same second as the whale's may in truth have come just
before it. Merges (exiting by combining both sides) are not seen as sales.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import sys
import time
from typing import Any, Callable
from zoneinfo import ZoneInfo

from . import api
from .daily import ist_day, token
from .fund import (FEE_RATE, _books_now, _clob_market, _closed_at, _fee_schedules, _Lookups, _Pace,
                   _sell_now, fee, iso_ts)

START_CASH = 1000.0
STAKE = 25.0
SIGNAL_USD = 100.0
TOP_N = 10
NEXT_S = 300             # how long after the whale the copy may keep filling
LAG_S = NEXT_S + 60      # replay only whale fills old enough to have 5 minutes of fills after them
MAX_PAGES = 40           # 500 fills a page, per market and per run
AHEAD_DAYS = 45          # events released within this many days are listed (the next Fed meeting)
KEEP_DAYS = 3            # ... and those released this many days ago, until they settle
KEEP_CLOSED = 300
SOLD_OUT = 0.02

# (name, title pattern, tz, local time, group, instruments)
BANKS = [
    ("Fed", r"\bFed\b|Federal Reserve|FOMC", "America/New_York", "14:00", "major",
     ["MNQ / NQ (Nasdaq-100)", "MES / ES (S&P 500)", "MGC / GC (gold)", "ZN (10-year note)", "DXY (dollar)"]),
    ("ECB", r"\bECB\b|European Central Bank", "Europe/Berlin", "14:15", "major",
     ["6E (EUR/USD)", "FESX (Euro Stoxx 50)", "FGBL (Bund)"]),
    ("Bank of England", r"Bank of England|\bBoE\b", "Europe/London", "12:00", "major",
     ["6B (GBP/USD)", "FTSE 100", "Gilts"]),
    ("Bank of Japan", r"Bank of Japan|\bBoJ\b", "Asia/Tokyo", "11:00", "major",
     ["6J (USD/JPY)", "NKD (Nikkei 225)"]),
    ("Bank of Canada", r"Bank of Canada", "America/Toronto", "09:45", "major", ["6C (USD/CAD)"]),
    ("RBA", r"Reserve Bank of Australia|\bRBA\b", "Australia/Sydney", "14:30", "major", ["6A (AUD/USD)", "ASX 200"]),
    ("RBNZ", r"Reserve Bank of New Zealand|\bRBNZ\b", "Pacific/Auckland", "14:00", "major", ["6N (NZD/USD)"]),
    ("SNB", r"Swiss National Bank|\bSNB\b", "Europe/Zurich", "09:30", "major", ["6S (USD/CHF)"]),
    ("RBI", r"Reserve Bank of India|\bRBI\b", "Asia/Kolkata", "10:00", "major", ["Nifty 50 / Bank Nifty", "USD/INR"]),
    ("Brazil", r"Bank of Brazil|Copom", "America/Sao_Paulo", "18:30", "emerging", ["USD/BRL", "EWZ"]),
    ("Mexico", r"Bank of Mexico|Banxico", "America/Mexico_City", "13:00", "emerging", ["6M (USD/MXN)"]),
    ("Korea", r"Bank of Korea", "Asia/Seoul", "09:40", "emerging", ["USD/KRW", "KOSPI"]),
    ("Israel", r"Bank of Israel", "Asia/Jerusalem", "16:00", "emerging", ["USD/ILS", "TA-35"]),
    ("Russia", r"Bank of Russia", "Europe/Moscow", "13:30", "emerging", ["USD/RUB"]),
    ("Colombia", r"Central Bank of Colombia", "America/Bogota", "13:00", "emerging", ["USD/COP"]),
    ("Chile", r"Central Bank of Chile", "America/Santiago", "18:00", "emerging", ["USD/CLP"]),
    ("South Africa", r"South African Reserve Bank", "Africa/Johannesburg", "15:00", "emerging", ["USD/ZAR"]),
]
_US_EQ = ["MNQ / NQ (Nasdaq-100)", "MES / ES (S&P 500)", "MGC / GC (gold)", "ZN (10-year note)", "DXY (dollar)"]
# (name, title pattern, local time ET)
DATA = [
    ("CPI", r"\bCPI\b|Inflation US|US inflation|inflation in the US", "08:30"),
    ("Jobs (NFP)", r"jobs added|nonfarm|non-farm|payrolls", "08:30"),
    ("Unemployment", r"unemployment rate", "08:30"),
    ("PCE", r"\bPCE\b", "08:30"),
    ("PPI", r"\bPPI\b", "08:30"),
    ("GDP", r"\bGDP\b", "08:30"),
    ("ISM", r"\bISM\b", "10:00"),
    ("Jobless claims", r"jobless claims|initial claims", "08:30"),
    ("JOLTS", r"JOLTS|job openings", "10:00"),
]
NON_US = re.compile(r"Eurozone|Euro area|German|\bUK\b|United Kingdom|Britain|Canada|Canadian|Japan|China|Korea|"
                    r"India|Australia|Brazil|Mexico|France|Spain|Ital|Argentin|Turk|Swiss|Switzerland", re.I)
ONE_MEETING = re.compile(r"(decision|interest rates|rates?:|cuts? rates|hike|cut).*(meeting|in \w+\??$|: \w+ \d{4}$)", re.I)
SKIP = re.compile(r"in 20\d\d\?|by \w+ \d|before 20\d\d|dissent|next fed|nothing ever|people.s bank|"
                  r"how many .*(cuts|hikes)|end of (the )?(year|20\d\d)|powell|warsh|chair|recession|emergency", re.I)
TAGS = ["fed", "fed-rates", "global-rates", "interest-rates", "ecb", "boe", "bank-of-england", "boj",
        "bank-of-japan", "bank-of-canada", "rba", "rbi", "snb", "central-banks", "economy", "inflation",
        "jobs-report", "economic-data", "gdp"]
MONTHS = {m: i for i, m in enumerate(("january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"), 1)}
SCHED = re.compile(r"scheduled (?:for|to be released on|to take place on|to be published on)\s+([A-Z][a-z]+)\s+"
                   r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?,?\s*(\d{4})")
NOTES = {
    "major": "Back-test 2023-26: a favourite priced at 80% or more two minutes before was right 81 of 81 times "
             "for these banks. Live since 25 Oct 2026: RBNZ (28 Oct) was 98.6% for a hike and held.",
    "emerging": "Back-test: emerging-market banks surprised at 81-98% (Colombia, South Africa, Israel). "
                "Treat a high price here as likely, not known.",
    "data": "Back-test: US data is rarely priced at 80%; the CPI favourite was right 32 of 59 times, "
            "jobs (NFP) 3 of 28. The price is the crowd's guess, not the answer.",
}
RULES = {"start_cash": START_CASH, "stake": STAKE, "signal_usd": SIGNAL_USD, "top_n": TOP_N,
         "next_s": NEXT_S, "lag_s": LAG_S}

_DATA_PACE, _GAMMA_PACE = _Pace(6), _Pace(5)


# ─────────────────────────── the board ──────────────────────────────────────

def classify(title: str) -> dict | None:
    """What release an event settles on, or None if it is not one scheduled release."""
    if SKIP.search(title or ""):
        return None
    for name, pat, tz, hm, group, inst in BANKS:
        if re.search(pat, title, re.I):
            if not ONE_MEETING.search(title):
                return None
            return {"kind": "central bank", "name": name, "tz": tz, "hm": hm, "group": group, "instruments": inst}
    if NON_US.search(title):
        return None
    for name, pat, hm in DATA:
        if re.search(pat, title, re.I):
            return {"kind": "US data", "name": name, "tz": "America/New_York", "hm": hm, "group": "data",
                    "instruments": _US_EQ}
    return None


def release_ts(info: dict, description: str, end_date: str | None) -> int | None:
    """The published release time on the scheduled day: the day from the rules text, else the end date."""
    day = None
    m = SCHED.search(description or "")
    if m and m.group(1).lower() in MONTHS:
        d = int(m.group(3) or m.group(2))
        try:
            day = dt.date(int(m.group(4)), MONTHS[m.group(1).lower()], d)
        except ValueError:
            day = None
    if day is None and end_date:
        try:
            day = dt.date.fromisoformat(end_date[:10])
        except ValueError:
            return None
    if day is None:
        return None
    hh, mm = map(int, info["hm"].split(":"))
    return int(dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=ZoneInfo(info["tz"])).timestamp())


def outcomes(e: dict) -> list[dict]:
    """[{label, cid, tokens: {token: side}, price}] -- one row per outcome the crowd prices."""
    out = []
    mk = [m for m in e.get("markets") or [] if m.get("conditionId") and not m.get("archived")]
    for m in mk:
        toks = api.parse_json_field(m.get("clobTokenIds")) or []
        names = api.parse_json_field(m.get("outcomes")) or []
        px = [float(x) for x in api.parse_json_field(m.get("outcomePrices")) or []]
        if len(toks) != 2 or len(names) != 2 or len(px) != 2:
            continue
        if len(mk) == 1:                       # one two-way market: both sides are outcomes
            for i in (0, 1):
                out.append({"label": names[i], "cid": m["conditionId"], "price": px[i],
                            "tokens": {str(toks[0]): names[0], str(toks[1]): names[1]}})
        else:
            lab = m.get("groupItemTitle") or m.get("question") or ""
            out.append({"label": lab, "cid": m["conditionId"], "price": px[0],
                        "tokens": {str(toks[0]): f"{names[0]} on {lab}", str(toks[1]): f"{names[1]} on {lab}"}})
    tot = sum(o["price"] for o in out if len(mk) > 1) or 1.0
    for o in out:
        o["odds"] = o["price"] / tot if len(mk) > 1 else o["price"]
    return out


def top_wallets(holders_by_cid: dict[str, list], labels: dict[str, str], n: int = TOP_N) -> list[dict]:
    """The n wallets with the most money in the event now, with what they hold and at what price.
    holders_by_cid: {condition: /v2/holders rows}; labels: {token: outcome label}."""
    by: dict[str, dict] = {}
    for rows in holders_by_cid.values():
        for tok_rows in rows:
            for h in tok_rows.get("holders") or []:
                w = (h.get("proxy_wallet") or "").lower()
                tok = str(h.get("token_id") or tok_rows.get("token_id") or "")
                val = float(h.get("current_value") or 0)
                avg = float(h.get("avg_price") or 0)
                if not w or val <= 0 or avg <= 0 or tok not in labels:   # protocol sinks hold at zero cost
                    continue
                d = by.setdefault(w, {"wallet": w, "name": h.get("name") or h.get("pseudonym") or "",
                                      "usd": 0.0, "pnl": 0.0, "positions": []})
                d["usd"] += val
                d["pnl"] += float(h.get("total_pnl") or 0)
                d["positions"].append({"token": tok, "label": labels[tok], "shares": float(h.get("amount") or 0),
                                       "avg_price": avg, "price": float(h.get("current_price") or 0), "usd": val})
    top = sorted(by.values(), key=lambda d: -d["usd"])[:n]
    for d in top:
        d["positions"].sort(key=lambda p: -p["usd"])
        d["side"] = d["positions"][0]["label"]
        d["side_share"] = d["positions"][0]["usd"] / d["usd"]
    return top


# ─────────────────────────── the copy account ───────────────────────────────

def new_state(now: int) -> dict:
    return {"v": 1, "started": now, "cursor": now, "cash": START_CASH, "open": [], "closed": [],
            "points": [[now, START_CASH]], "seq": 0, "fees": 0.0, "eps": {}, "top": {}, "names": {}, "markets": {},
            "counts": {"signals": 0, "copied": 0, "held": 0, "missed_cash": 0, "missed_liquidity": 0,
                       "partial_exits": 0}, "last_run": None}


def walk(takers: list[dict], after: int, skip_tx: str, side: str, *, usd: float | None = None,
         shares: float | None = None) -> dict:
    """Fill against the takers who traded `side` after a whale's fill, in time order, for up to NEXT_S seconds,
    until `usd` is spent (a buy) or `shares` are sold. Returns {shares, usd, fee_base, fills, last}.
    takers: /v2/trades taker rows of one token, oldest first."""
    got_sh = got_usd = fee_base = 0.0
    n, last = 0, None
    for r in takers:
        ts = int(r["timestamp"])
        if ts < after:
            continue
        if ts > after + NEXT_S:
            break
        if r.get("side") != side or (r.get("transaction_hash") or "") == skip_tx:
            continue
        price, size = float(r.get("price") or 0), float(r.get("size") or 0)
        if not 0 < price < 1 or size <= 0:
            continue
        if usd is not None:
            take = min(size, (usd - got_usd) / price)
        else:
            take = min(size, shares - got_sh)
        if take <= 0:
            break
        got_sh += take
        got_usd += take * price
        fee_base += take * price * (1 - price)
        n, last = n + 1, ts
        if (usd is not None and got_usd >= usd - 1e-9) or (shares is not None and got_sh >= shares - 1e-9):
            break
    return {"shares": got_sh, "usd": got_usd, "fee_base": fee_base, "fills": n, "last": last}


def _close(state: dict, p: dict, ts: int, how: str, payout: float | None) -> None:
    rest = p["shares"] * p["left"]
    got = sum(s["usd"] - s["fee"] for s in p["sales"]) + (rest * payout if payout is not None else 0.0)
    pnl = got - p["cost"] - p["fee"]
    state["closed"].append({**{k: p[k] for k in ("id", "event", "title", "slug", "label", "whale", "whale_name",
                                                 "ts", "whale_price", "price", "fills", "delay_s")},
                            "close_ts": ts, "how": how, "payout": payout, "pnl": pnl, "won": pnl > 0,
                            "sold_frac": 1 - p["left"], "cost": p["cost"] + p["fee"]})
    state["open"].remove(p)


def step(state: dict, fills: list[dict], takers: dict[str, list], market: Callable[[str], dict | None],
         closed_at: Callable[[str], int | None], until: int, fee_rates: dict[str, float]) -> int:
    """Replay the whale fills of one window (cursor, until] in time order through the copy account.
    fills: /v2/trades rows (maker and taker) of the tracked markets; takers: {token: taker rows, oldest first}.
    Returns the number of signals."""
    top = {cid: set(ws) for cid, ws in state["top"].items()}
    due = []
    for p in state["open"]:
        m = market(p["condition"])
        tok = token(m, p["token"])
        if tok is not None and m.get("resolved"):
            t = closed_at(p["condition"])
            if t is not None and t <= until:
                due.append((max(t, p["ts"]), p["id"], 1.0 if tok["winner"] else 0.0))
    due.sort()

    def pay_until(ts: int) -> None:
        while due and due[0][0] < ts:
            t, pid, payout = due.pop(0)
            p = next((p for p in state["open"] if p["id"] == pid), None)
            if p is not None:
                state["cash"] += p["shares"] * p["left"] * payout
                _close(state, p, t, "settled", payout)

    c = state["counts"]
    signals = 0
    rows = [r for r in fills if state["cursor"] < int(r["timestamp"]) <= until]
    for r in sorted(rows, key=lambda r: (int(r["timestamp"]), r.get("side") != "BUY")):
        ts, side = int(r["timestamp"]), r.get("side")
        w, tok, cid = (r.get("proxy_wallet") or "").lower(), str(r.get("token_id") or ""), r.get("condition_id") or ""
        size, price = float(r.get("size") or 0), float(r.get("price") or 0)
        if not tok or size <= 0:
            continue
        pay_until(ts)
        tx = r.get("transaction_hash") or ""
        for p in [p for p in state["open"] if p["whale"] == w and p["token"] == tok]:
            if side == "BUY":
                p["whale_held"] += size
            elif side == "SELL" and p["whale_held"] > 1e-9:
                take = min(size, p["whale_held"])
                frac = p["left"] * take / p["whale_held"]
                p["whale_held"] -= take
                if p["left"] - frac < SOLD_OUT:
                    frac = p["left"]
                want = p["shares"] * frac
                got = walk(takers.get(tok, []), ts, tx, "SELL", shares=want)
                if got["shares"] <= 1e-9:
                    c["partial_exits"] += 1          # no taker sold within 5 minutes: the copy stays held
                    continue
                done = frac * min(1.0, got["shares"] / want)
                if got["shares"] < want - 1e-9:
                    c["partial_exits"] += 1
                fe = p["fee_rate"] * got["fee_base"]
                p["sales"].append({"ts": got["last"], "frac": done, "usd": got["usd"], "fee": fe,
                                   "price": got["usd"] / got["shares"], "whale_price": price})
                p["left"] -= done
                state["cash"] += got["usd"] - fe
                state["fees"] = state.get("fees", 0.0) + fe
                if p["left"] <= 1e-9:
                    _close(state, p, got["last"], "sold", None)
        if side != "BUY" or w not in top.get(cid, ()):
            continue
        ep = state["eps"].setdefault(f"{w}|{tok}|{ist_day(ts)}", {"usd": 0.0, "shares": 0.0, "signaled": False})
        ep["usd"] += size * price
        ep["shares"] += size
        if ep["signaled"] or ep["usd"] < SIGNAL_USD:
            continue
        ep["signaled"] = True
        if not 0.001 < price < 0.999:
            continue
        signals += 1
        c["signals"] += 1
        if any(p["token"] == tok for p in state["open"]):
            c["held"] += 1
            continue
        rate = fee_rates.get(cid, FEE_RATE)
        if state["cash"] < STAKE * (1 + rate * 0.25):
            c["missed_cash"] += 1
            continue
        got = walk(takers.get(tok, []), ts, tx, "BUY", usd=STAKE)
        if got["usd"] < STAKE - 0.01:
            c["missed_liquidity"] += 1
            continue
        fe = rate * got["fee_base"]
        state["cash"] -= got["usd"] + fe
        state["fees"] = state.get("fees", 0.0) + fe
        state["seq"] += 1
        c["copied"] += 1
        info = state["markets"].get(cid, {})
        p = {"id": state["seq"], "token": tok, "condition": cid, "event": info.get("event", ""),
             "title": info.get("title") or r.get("title") or "", "slug": info.get("slug") or r.get("event_slug") or "",
             "label": (info.get("labels") or {}).get(tok) or r.get("outcome") or "",
             "whale": w, "whale_name": state["names"].get(w) or r.get("name") or "",
             "ts": got["last"], "whale_ts": ts, "whale_price": price, "price": got["usd"] / got["shares"],
             "shares": got["shares"], "cost": got["usd"], "fee": fe, "fee_rate": rate, "fills": got["fills"],
             "delay_s": got["last"] - ts, "whale_held": ep["shares"], "left": 1.0, "sales": []}
        state["open"].append(p)
        m = market(cid)
        t = closed_at(cid) if m and m.get("resolved") else None
        tk = token(m, tok)
        if t is not None and t <= until and tk is not None:
            due.append((max(t, p["ts"]), p["id"], 1.0 if tk["winner"] else 0.0))
            due.sort()
    pay_until(until + 1)
    return signals


def settle_and_mark(state: dict, market: Callable, now: int, sell_value: Callable[[dict], float | None]) -> None:
    """Pay out what settled with no known close time, value the rest at what it would sell for now."""
    for p in list(state["open"]):
        m = market(p["condition"])
        tok = token(m, p["token"])
        if tok is None:
            continue
        if m.get("resolved"):
            payout = 1.0 if tok["winner"] else 0.0
            p["mark"] = payout
            p.setdefault("resolved_seen", now)
            if p["resolved_seen"] <= state["cursor"]:
                state["cash"] += p["shares"] * p["left"] * payout
                _close(state, p, p["resolved_seen"], "settled", payout)
            continue
        p["quoted"] = tok["price"]
        rem = p["shares"] * p["left"]
        v = sell_value(p)
        if v is not None:
            p["mark"] = v / rem if rem > 1e-12 else 0.0
    value = sum(p["shares"] * p["left"] * p.get("mark", p["price"]) for p in state["open"])
    state["points"].append([now, round(state["cash"] + value, 4)])
    state["closed"] = sorted(state["closed"], key=lambda x: x["close_ts"])[-KEEP_CLOSED:]
    keep = ist_day(now - 2 * 86400)
    state["eps"] = {k: v for k, v in state["eps"].items() if k.rsplit("|", 1)[1] >= keep}


def fund_view(state: dict) -> dict:
    def r(v, n=2):
        return None if v is None else round(v, n)
    pts = state["points"]
    peak, dd = START_CASH, 0.0
    for _, v in pts:
        peak, dd = max(peak, v), max(dd, max(peak, v) - v)
    closed = state["closed"]
    open_rows = []
    for p in sorted(state["open"], key=lambda p: -p["ts"]):
        val = p["shares"] * p["left"] * p.get("mark", p["price"])
        got = sum(s["usd"] - s["fee"] for s in p["sales"])
        open_rows.append({**{k: p.get(k) for k in ("id", "event", "title", "slug", "label", "whale", "whale_name",
                                                   "ts", "fills", "delay_s")},
                          "whale_price": r(p["whale_price"], 4), "price": r(p["price"], 4),
                          "mark": r(p.get("mark"), 4), "quoted": r(p.get("quoted"), 4),
                          "cost": r(p["cost"] + p["fee"]), "value": r(val), "pnl_now": r(val + got - p["cost"] - p["fee"]),
                          "sold_frac": r(1 - p["left"], 4), "settling": "resolved_seen" in p})
    copies = [*state["open"], *closed]
    gap = [c["price"] - c["whale_price"] for c in copies if c.get("whale_price")]
    held_end = [c for c in closed if c["how"] == "settled" and c["sold_frac"] < 0.5]
    realized = sum(c["pnl"] for c in closed)
    unreal = sum(x["pnl_now"] for x in open_rows)
    return {"start": START_CASH, "started": state["started"], "equity": r(pts[-1][1]),
            "pnl": r(pts[-1][1] - START_CASH), "cash": r(state["cash"]), "realized": r(realized),
            "unrealized": r(unreal), "open_n": len(state["open"]), "closed_n": len(closed),
            "won": sum(c["won"] for c in closed), "lost": sum(not c["won"] for c in closed),
            "win_rate": r(sum(c["won"] for c in closed) / len(closed), 4) if closed else None,
            "baseline": r(sum(c["price"] for c in held_end) / len(held_end), 4) if held_end else None,
            "fees": r(state.get("fees", 0.0)),
            "gap_cents": r(100 * sum(gap) / len(gap), 2) if gap else None,
            "counts": state["counts"], "max_dd": r(dd), "points": [[t, r(v)] for t, v in pts[-600:]],
            "open": open_rows,
            "closed": [{**x, "pnl": r(x["pnl"]), "price": r(x["price"], 4), "whale_price": r(x["whale_price"], 4),
                        "cost": r(x["cost"])} for x in sorted(closed, key=lambda x: -x["close_ts"])]}


# ─────────────────────────── fetching ───────────────────────────────────────

def _events() -> tuple[list[dict], int]:
    """Open events under the news tags, and how many tag listings could not be read."""
    seen: dict[str, dict] = {}
    failed = 0
    for tag in TAGS:
        cursor = None
        for _ in range(10):
            _GAMMA_PACE()
            p = {"tag_slug": tag, "closed": False, "limit": 100}
            if cursor:
                p["after_cursor"] = cursor
            try:
                body = api._get(api.GAMMA, "/events/keyset", p, retries=3, timeout=30)
            except api.PolymarketError as e:
                print(f"  ! news events {tag}: {e}", file=sys.stderr)
                failed += 1
                break
            for e in body.get("events") or []:
                seen.setdefault(str(e.get("id")), e)
            cursor = body.get("next_cursor")
            if not cursor or not body.get("events"):
                break
    return list(seen.values()), failed


def _holders(cid: str) -> list:
    _DATA_PACE()
    return api.market_holders(cid, limit=100)


def _fills(cid: str, since: int, taker_only: bool) -> tuple[list[dict], bool]:
    """Fills of one market after `since`, oldest first, and whether the page cap cut them."""
    out, pages = [], 0
    p = {"condition": cid, "taker_only": taker_only, "limit": 500}
    while True:
        _DATA_PACE()
        body = api._get(api.DATA, "/v2/trades", p, retries=3, timeout=45)
        rows = body.get("data") or []
        pages += 1
        old = False
        for row in rows:
            if int(row.get("timestamp") or 0) <= since:
                old = True
                continue
            out.append(row)
        cur = (body.get("pagination") or {}).get("next_cursor")
        if old or not rows or not cur:
            return sorted(out, key=lambda r: int(r["timestamp"])), False
        if pages >= MAX_PAGES:
            return sorted(out, key=lambda r: int(r["timestamp"])), True
        p["cursor"] = cur


def build_board(now: int, workers: int, log) -> tuple[list[dict], dict, dict, int]:
    """(events for the page, {condition: top wallets}, {condition: market info}, tag listings that failed)."""
    board = []
    found, failed = _events()
    for e in found:
        info = classify(e.get("title") or "")
        if info is None:
            continue
        T = release_ts(info, e.get("description") or "", e.get("endDate"))
        if T is None or not (now - KEEP_DAYS * 86400 <= T <= now + AHEAD_DAYS * 86400):
            continue
        outs = outcomes(e)
        if not outs:
            continue
        board.append((T, e, info, outs))
    board.sort(key=lambda x: x[0])
    cids = sorted({o["cid"] for _, _, _, outs in board for o in outs})
    holders = _Lookups(_holders, budget=20)
    holders.prefetch([(c,) for c in cids], workers)
    events, top, markets = [], {}, {}
    for T, e, info, outs in board:
        labels = {t: lab for o in outs for t, lab in o["tokens"].items()}
        by_cid = {o["cid"]: holders(o["cid"]) or [] for o in outs}
        whales = top_wallets(by_cid, labels)
        fav = max(outs, key=lambda o: o["odds"])
        slug = e.get("slug") or ""
        for o in outs:
            top[o["cid"]] = [w["wallet"] for w in whales]
            markets[o["cid"]] = {"event": e.get("title") or "", "slug": slug, "title": e.get("title") or "",
                                 "labels": {t: lab for t, lab in o["tokens"].items()}}
        events.append({
            "slug": slug, "title": e.get("title") or "", "kind": info["kind"], "name": info["name"],
            "group": info["group"], "release_ts": T, "release_local": f"{info['hm']} {info['tz']}",
            "instruments": info["instruments"], "note": NOTES[info["group"]],
            "volume": round(float(e.get("volume") or 0)), "volume24h": round(float(e.get("volume24hr") or 0)),
            "favourite": fav["label"], "fav_odds": round(fav["odds"], 4),
            "outcomes": [{"label": o["label"], "odds": round(o["odds"], 4)}
                         for o in sorted(outs, key=lambda o: -o["odds"]) if o["odds"] >= 0.005][:8],
            "whales": [{"wallet": w["wallet"], "name": w["name"], "usd": round(w["usd"]), "pnl": round(w["pnl"]),
                        "side": w["side"], "side_share": round(w["side_share"], 3),
                        "positions": [{"label": p["label"], "usd": round(p["usd"]), "shares": round(p["shares"]),
                                       "avg_price": round(p["avg_price"], 4), "price": round(p["price"], 4)}
                                      for p in w["positions"][:4]]} for w in whales],
        })
    log(f"  news: {len(events)} events, {len(cids)} markets, {holders.fails} holder lookups failed")
    return events, top, markets, failed


def build_news(*, now_ts: int, out_dir: str, workers: int = 6, log=print) -> dict[str, Any]:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "state.json")
    try:
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = None
    events, top_now, markets_now, board_failed = build_board(now_ts, workers, log)
    names_now = {w["wallet"]: w["name"] for ev in events for w in ev["whales"]}

    if state is None:
        state = new_state(now_ts)
        log(f"  news: opened the ${START_CASH:,.0f} copy account; it copies from the next run")
    else:
        start, until = state["cursor"], now_ts - LAG_S
        cids = sorted(set(state["top"]) | {p["condition"] for p in state["open"]})
        fills, takers, cut, failed = [], {}, 0, []
        if until > start:
            def one(cid):
                a, ta = _fills(cid, start, False)
                b, tb = _fills(cid, start, True)
                return cid, a, b, ta or tb
            with cf.ThreadPoolExecutor(max_workers=workers) as ex:
                for fut in cf.as_completed([ex.submit(one, c) for c in cids]):
                    try:
                        cid, a, b, t = fut.result()
                    except api.PolymarketError as e:
                        failed.append(str(e)[:80])
                        continue
                    fills.extend(a)
                    cut += t
                    for row in b:
                        takers.setdefault(str(row.get("token_id") or ""), []).append(row)
        for rows in takers.values():
            rows.sort(key=lambda r: int(r["timestamp"]))
        if failed:
            log(f"  ! news: {len(failed)} markets unreadable; this window is replayed next run")
            fills, until = [], start
        market, closed = _Lookups(_clob_market), _Lookups(_closed_at)
        rates = _fee_schedules(sorted(set(cids)))
        signals = 0
        if until > start:
            signals = step(state, fills, takers, market, closed, until, rates)
            state["cursor"] = until
        books = _books_now(sorted({p["token"] for p in state["open"]}))
        settle_and_mark(state, market, now_ts, lambda p: _sell_now(p, books))
        state["last_run"] = {"at": now_ts, "from": start, "to": state["cursor"], "fills": len(fills),
                             "signals": signals, "markets": len(cids), "truncated": cut}
        log(f"  news: replayed {len(fills)} fills in {len(cids)} markets, {signals} signals, "
            f"equity ${state['points'][-1][1]:,.2f} ({len(state['open'])} open)")
    # the list the NEXT window copies from (no look-ahead); an open copy's market stays readable
    if top_now:
        # a tag listing that could not be read hides its events this run, not for good: keep their lists
        state["top"] = {**state["top"], **top_now} if board_failed else top_now
        state["names"] = {**state.get("names", {}), **names_now}
        keep = state["markets"] if board_failed else {p["condition"]: state["markets"].get(p["condition"], {})
                                                      for p in state["open"]}
        state["markets"] = {**keep, **markets_now}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, separators=(",", ":"), ensure_ascii=False)
    doc = {"generated_at": now_ts, "rules": RULES, "events": events, "fund": fund_view(state),
           "last_run": state.get("last_run")}
    with open(os.path.join(out_dir, "news.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"), ensure_ascii=False)
    return {"events": len(events), "equity": doc["fund"]["equity"]}


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="../docs/data/news")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    t0 = time.time()
    out = build_news(now_ts=int(t0), out_dir=args.out, workers=args.workers, log=lambda m: print(m, flush=True))
    print(f"news done in {time.time() - t0:.0f}s: {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
