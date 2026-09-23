"""DAILY RECAP -- what the proven whales did each day, and how it went.

WHY THIS EXISTS
---------------
The owner cannot watch the tape all day (he works and studies), so this keeps the
record for him: one file per India-time day holding every position the "Worth
following" whales opened that day, whether they sold it, whether it won, and what
copying it would have made. He reads today's so far during the day, and yesterday's
the next morning -- "what did they do, what did I miss".

WHAT COUNTS, AND WHY
--------------------
* Whales: verdict CANDIDATE only ("Worth following"). PROMISING and RISKY are left
  out on purpose -- the owner asked for the proven ones, not the promising or new.
* Entry: every BUY of one outcome token on one India-time day, as one position at
  its volume-weighted price. Whales slice orders; 483 fills in a day from one
  wallet is not 483 decisions.
* Exit: a later SELL of that token closes the OLDEST open entry first. Sells with
  no entry inside the tracked window are listed separately as exits of older
  positions -- their entry price is unknown, so no profit is claimed for them.
  Known approximation: a whale topping up a position it opened BEFORE the window
  can make the new entry look sold, because the older lot is invisible here.
* Settled: the CLOB market's own winner flag. A price at or beyond 99c / 1c with no
  flag yet is "decided" and valued at 1 / 0. Anything else is OPEN, marked at the
  current price, and never counted as a win or a loss.
* Combos (parlays such as "LoL: A vs B AND LoL: C vs D ...") carry a synthetic
  64-character condition id with no CLOB market behind it (404, verified
  2026-09-23), so they are listed as "combo" and never scored.
* Floor: entries under $100 are dropped as noise. The census on 2026-09-23 found
  2,080 entries in a day, median $50; 781 were >= $100.

THE COPY NUMBER IS A CEILING, NOT A FORECAST
--------------------------------------------
"If you had copied with $100" uses the whale's OWN price and follows the whale's
OWN exit. A real copy is later and worse (see paper.py for the decay-vs-delay
study). Taker fees ARE charged on the copy -- rate * shares * p * (1 - p) on entry
and on a sell, none on a settlement payout -- because a fee-blind copy number is
the easiest way to invent a strategy that does not exist.

THE BASELINE BESIDE EVERY WIN RATE
----------------------------------
A buyer with no skill who pays 70c wins about 70% of the time -- that is what the
price says. So each closed entry carries its no-skill chance: the entry price if
it was held to settlement, 50% if it was sold first. A whale is only showing skill
where the win rate beats that baseline.

REFRESH
-------
Outcomes keep arriving after the day ends (markets settle, whales sell), so every
run recomputes today and the two days before from a fresh pull of the whole
window. Older days are left as last written.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
import os
import sys
from typing import Any

from . import api
from .feed import categorize

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
RECAP_VERDICTS = {"CANDIDATE"}
REFRESH_DAYS = 3
MIN_ENTRY_USD = 100.0
STAKE_USD = 100.0
FEE_RATE = 0.05           # the middle of Polymarket's category rates, as in paper.py
DECIDED = 0.99            # a price this close to 1 (or to 0) is decided, pending settlement
SOLD_OUT = 0.02           # holding less than 2% of what was bought = fully sold
PAGE = 500                # /activity caps limit at 500 ...
MAX_OFFSET = 5000         # ... and offset at 5000 (HTTP 400 beyond, verified 2026-09-23)


def ist_day(ts: int) -> str:
    return dt.datetime.fromtimestamp(int(ts), IST).strftime("%Y-%m-%d")


def day_start(day: str) -> int:
    return int(dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=IST).timestamp())


def shift_day(day: str, n: int) -> str:
    d = dt.datetime.strptime(day, "%Y-%m-%d") + dt.timedelta(days=n)
    return d.strftime("%Y-%m-%d")


def fee(shares: float, price: float) -> float:
    return FEE_RATE * shares * price * (1.0 - price)


# ─────────────────────────── pure logic (tested) ────────────────────────────

def entries_for_wallet(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """One wallet's activity rows -> (entries, exits of positions opened earlier).

    Every BUY of a token on one India-time day joins that day's entry for the
    token; a SELL closes the oldest open entry of the token first.
    """
    fills = sorted((r for r in rows if r.get("type") == "TRADE" and r.get("asset")
                    and float(r.get("size") or 0) > 0),
                   key=lambda r: (int(r.get("timestamp") or 0), r.get("side") != "BUY"))
    lots: dict[str, list[dict]] = {}
    entries: list[dict] = []
    older: dict[tuple[str, str], dict] = {}
    for r in fills:
        ts, asset = int(r["timestamp"]), str(r["asset"])
        size = float(r["size"])
        usd = float(r.get("usdcSize") or 0) or size * float(r.get("price") or 0)
        if r.get("side") == "BUY":
            day = ist_day(ts)
            open_lots = lots.setdefault(asset, [])
            e = next((x for x in open_lots if x["day"] == day), None)
            if e is None:
                e = {"asset": asset, "condition": r.get("conditionId") or "",
                     "outcome": r.get("outcome") or "", "title": r.get("title") or "",
                     "slug": r.get("slug") or "", "event": r.get("eventSlug") or "",
                     "day": day, "first_ts": ts, "last_ts": ts, "fills": 0,
                     "shares": 0.0, "usd": 0.0, "sold": 0.0, "sold_usd": 0.0, "sell_ts": 0}
                open_lots.append(e)
                entries.append(e)
            e["fills"] += 1
            e["shares"] += size
            e["usd"] += usd
            e["last_ts"] = ts
        elif r.get("side") == "SELL":
            left, price = size, usd / size
            for e in lots.get(asset, []):
                room = e["shares"] - e["sold"]
                if room <= 1e-9:
                    continue
                take = min(room, left)
                e["sold"] += take
                e["sold_usd"] += take * price
                e["sell_ts"] = ts
                left -= take
                if left <= 1e-9:
                    break
            if left > 1e-9:
                k = (asset, ist_day(ts))
                o = older.setdefault(k, {"asset": asset, "condition": r.get("conditionId") or "",
                                         "outcome": r.get("outcome") or "",
                                         "title": r.get("title") or "", "slug": r.get("slug") or "",
                                         "day": k[1], "ts": ts, "shares": 0.0, "usd": 0.0})
                o["shares"] += left
                o["usd"] += left * price
                o["ts"] = ts
    for e in entries:
        e["entry"] = e["usd"] / e["shares"]
        e["exit"] = e["sold_usd"] / e["sold"] if e["sold"] > 1e-9 else None
    return entries, list(older.values())


def is_combo(e: dict) -> bool:
    """A parlay: synthetic condition id, no single outcome, legs joined by AND."""
    return len(e.get("condition") or "") != 66 or (not e.get("outcome") and " AND " in (e.get("title") or ""))


def settle(e: dict, market: dict | None) -> dict:
    """Value one entry now: what was sold, what the rest is worth, won/lost/open,
    the whale's P&L on it, and a $100 copy's P&L after fees."""
    shares, entry = e["shares"], e["entry"]
    sold_frac = min(1.0, e["sold"] / shares)
    tok = token(market, e["asset"])
    price = tok["price"] if tok else None
    if tok and market.get("resolved"):
        state, value = "settled", 1.0 if tok["winner"] else 0.0
    elif price is not None and (price >= DECIDED or price <= 1 - DECIDED):
        state, value = "decided", float(round(price))
    elif price is not None:
        state, value = "open", price
    else:
        state, value = ("combo" if is_combo(e) else "unknown"), None

    sold_out = sold_frac >= 1 - SOLD_OUT
    if sold_out:
        state, value = "sold", value
    closed = sold_out or state in ("settled", "decided")
    held = shares - e["sold"]
    if value is None and not sold_out:
        whale_pnl = copy_pnl = None
    else:
        v = value if value is not None else 0.0
        whale_pnl = e["sold_usd"] + (0.0 if sold_out else held * v) - e["usd"]
        c_shares = STAKE_USD / entry if entry > 0 else 0.0
        exit_px = e["exit"] or 0.0
        worth = c_shares * (sold_frac * exit_px + (0.0 if sold_out else (1 - sold_frac) * v))
        fees = fee(c_shares, entry) + (fee(c_shares * sold_frac, exit_px) if sold_frac else 0.0)
        copy_pnl = worth - fees - STAKE_USD

    if not closed:
        status = "open" if state == "open" else "unknown"
    else:
        status = "won" if whale_pnl is not None and whale_pnl > 0 else "lost"
    # the no-skill chance of this result: the price paid, if held to the end;
    # a coin, if the whale sold first
    baseline = (0.5 if sold_frac >= 0.5 else entry) if closed else None
    return {"state": state, "value": value, "price_now": price, "sold_frac": sold_frac,
            "closed": closed, "status": status, "whale_pnl": whale_pnl,
            "copy_pnl": copy_pnl, "baseline": baseline}


def token(market: dict | None, asset: str) -> dict | None:
    """This outcome token's {price, winner}. In a settled binary market knowing one
    side is enough: the other side won exactly when this one did not."""
    if not market:
        return None
    toks = market.get("tokens") or {}
    if asset in toks:
        return toks[asset]
    if market.get("resolved") and len(toks) == 1:
        (other,) = toks.values()
        return {"price": 1.0 - other["price"], "winner": not other["winner"]}
    return None


def summarise(rows: list[dict]) -> dict:
    """Headline numbers for any set of settled entry rows."""
    closed = [r for r in rows if r["status"] in ("won", "lost")]
    won = sum(1 for r in closed if r["status"] == "won")
    opened = [r for r in rows if r["status"] == "open"]
    return {
        "entries": len(rows),
        "entry_usd": round(sum(r["usd"] for r in rows), 2),
        "closed": len(closed), "won": won, "lost": len(closed) - won,
        "open": len(opened), "unknown": sum(1 for r in rows if r["status"] == "unknown"),
        "win_rate": round(won / len(closed), 4) if closed else None,
        "baseline": round(sum(r["baseline"] for r in closed) / len(closed), 4) if closed else None,
        "copy_pnl_closed": round(sum(r["copy_pnl"] or 0 for r in closed), 2),
        "copy_pnl_open": round(sum(r["copy_pnl"] or 0 for r in opened), 2),
        "whale_pnl_closed": round(sum(r["whale_pnl"] or 0 for r in closed), 2),
    }


# ─────────────────────────── fetching ───────────────────────────────────────

def _activity(wallet: str, start: int, end: int) -> tuple[list[dict], bool]:
    """Every activity row in [start, end]. True second value = hit the offset cap."""
    rows: list[dict] = []
    for offset in range(0, MAX_OFFSET + 1, PAGE):
        page = api._get(api.DATA, "/activity", {"user": wallet, "limit": PAGE, "offset": offset,
                                                "start": start, "end": end})
        page = page if isinstance(page, list) else (page.get("data") or [])
        rows.extend(page)
        if len(page) < PAGE:
            return rows, False
    return rows, True


def _market(condition: str) -> dict | None:
    """CLOB market state: token -> {price, winner}, keyed by the token id that
    activity rows carry as `asset`. One market per request. (Not because Gamma
    cannot batch: an earlier note here said /markets/keyset returns ONE market for
    any number of condition_ids, but that was the relay dropping repeated params --
    see feed._end_dates.)"""
    try:
        m = api._get(api.CLOB, f"/markets/{condition}", retries=2, timeout=20)
    except api.PolymarketError:
        return None
    tokens = {str(t.get("token_id")): {"price": float(t.get("price") or 0),
                                       "winner": bool(t.get("winner"))}
              for t in (m.get("tokens") or []) if t.get("token_id")}
    if not tokens:
        return None
    return {"tokens": tokens,
            "resolved": bool(m.get("closed")) and any(t["winner"] for t in tokens.values()),
            "end": m.get("end_date_iso") or ""}


# ─────────────────────────── build ──────────────────────────────────────────

def _r(v, n):
    return round(v, n) if v is not None else None


def _entry_row(e: dict, s: dict, card: dict) -> dict:
    """One entry as published. `wallet`, `condition` and `asset` are working fields:
    build_daily swaps the wallet for an index into the day's whale list and keeps
    condition + asset only on OPEN rows, which the page re-prices live."""
    return {
        "wallet": card["wallet"], "ts": e["first_ts"],
        "title": e["title"], "slug": e["slug"], "outcome": e["outcome"],
        "category": categorize(e["title"], e["slug"]),
        "condition": e["condition"], "asset": e["asset"],
        "usd": round(e["usd"], 2), "entry": round(e["entry"], 4), "fills": e["fills"],
        "sold_frac": round(s["sold_frac"], 3), "exit": _r(e["exit"], 4),
        "sell_ts": e["sell_ts"] or None,
        "state": s["state"], "status": s["status"], "value": _r(s["value"], 4),
        "whale_pnl": _r(s["whale_pnl"], 2), "copy_pnl": _r(s["copy_pnl"], 2),
        "baseline": _r(s["baseline"], 4),
    }


def build_daily(cards: list[dict], *, now_ts: int, out_dir: str, workers: int = 8,
                log=print) -> dict[str, Any]:
    whales = [c for c in cards if c.get("verdict") in RECAP_VERDICTS]
    today = ist_day(now_ts)
    days = [shift_day(today, -i) for i in range(REFRESH_DAYS)]
    start = day_start(days[-1])
    log(f"  daily: {len(whales)} worth-following whales, days {days[-1]}..{today} (IST)")

    pulled: dict[str, tuple[list[dict], bool]] = {}
    failed = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_activity, c["wallet"], start, now_ts): c for c in whales}
        for fut in cf.as_completed(futs):
            c = futs[fut]
            try:
                pulled[c["wallet"]] = fut.result()
            except api.PolymarketError as err:
                failed += 1
                print(f"  ! daily activity {c['wallet']}: {err}", file=sys.stderr)

    by_wallet = {c["wallet"]: c for c in whales}
    raw: list[tuple[dict, dict]] = []
    older: list[tuple[dict, dict]] = []
    for w, (rows, _cut) in pulled.items():
        ents, olds = entries_for_wallet(rows)
        raw.extend((e, by_wallet[w]) for e in ents if e["usd"] >= MIN_ENTRY_USD)
        older.extend((o, by_wallet[w]) for o in olds if o["usd"] >= MIN_ENTRY_USD)

    # Only entries still (partly) held need a market lookup, and a settled market
    # never changes -- each day file's `settled` map (condition -> outcome -> 1/0)
    # answers for it on the next run instead of the CLOB.
    done: dict[tuple[str, str], float] = {}
    for d in days:
        try:
            with open(os.path.join(out_dir, f"{d}.json"), encoding="utf-8") as f:
                old = json.load(f).get("settled") or {}
        except (OSError, ValueError):
            continue
        for cid, outs in old.items():
            for outcome, v in outs.items():
                done[(cid, outcome)] = v
    markets: dict[str, dict] = {}
    for e, _ in raw:
        v = done.get((e["condition"], e["outcome"]))
        if v is not None:
            m = markets.setdefault(e["condition"], {"resolved": True, "tokens": {}})
            m["tokens"][e["asset"]] = {"price": float(v), "winner": v == 1}
    reused = len(markets)
    need = sorted({e["condition"] for e, _ in raw
                   if not is_combo(e) and e["shares"] - e["sold"] > SOLD_OUT * e["shares"]
                   and token(markets.get(e["condition"]), e["asset"]) is None})
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for cid, m in zip(need, ex.map(_market, need)):
            if m:
                markets[cid] = m
    log(f"  daily: {len(raw)} entries >= ${MIN_ENTRY_USD:.0f}; {reused} settled markets reused, "
        f"{len(need)} looked up")

    rows_by_day: dict[str, list[dict]] = {d: [] for d in days}
    for e, card in raw:
        if e["day"] in rows_by_day:
            rows_by_day[e["day"]].append(_entry_row(e, settle(e, markets.get(e["condition"])), card))
    exits_by_day: dict[str, list[dict]] = {d: [] for d in days}
    for o, card in older:
        if o["day"] in exits_by_day:
            exits_by_day[o["day"]].append({
                "wallet": card["wallet"], "ts": o["ts"], "title": o["title"], "slug": o["slug"],
                "outcome": o["outcome"], "category": categorize(o["title"], o["slug"]),
                "usd": round(o["usd"], 2), "price": round(o["usd"] / o["shares"], 4)})

    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(out_dir, "index.json")
    try:
        with open(index_path, encoding="utf-8") as f:
            index = {d["date"]: d for d in json.load(f).get("days", [])}
    except (OSError, ValueError):
        index = {}

    cut = sorted(w for w, (_, c) in pulled.items() if c)
    for d in days:
        rows = sorted(rows_by_day[d], key=lambda r: -r["ts"])
        per: dict[str, list[dict]] = {}
        for r in rows:
            per.setdefault(r["wallet"], []).append(r)
        whale_rows = []
        for w, rs in per.items():
            c = by_wallet[w]
            whale_rows.append({"wallet": w, "name": c.get("name"), "category": c.get("category"),
                               "net_dd": c.get("net_dd"), **summarise(rs),
                               "exits_older": sum(1 for o in exits_by_day[d] if o["wallet"] == w)})
        whale_rows.sort(key=lambda x: -x["entry_usd"])
        pos = {x["wallet"]: i for i, x in enumerate(whale_rows)}
        settled: dict[str, dict[str, float]] = {}
        for r in rows:
            r["w"] = pos[r.pop("wallet")]
            cid, asset = r.pop("condition"), r.pop("asset")
            if r["state"] == "settled":
                settled.setdefault(cid, {})[r["outcome"]] = r["value"]
            elif r["status"] == "open":
                r["condition"], r["asset"] = cid, asset
        cats: dict[str, list[dict]] = {}
        for r in rows:
            cats.setdefault(r["category"], []).append(r)
        summary = summarise(rows)
        doc = {
            "date": d, "tz": "Asia/Kolkata", "generated_at": now_ts,
            "day_start": day_start(d), "day_end": day_start(shift_day(d, 1)),
            "entries_complete": d < today,
            "stake_usd": STAKE_USD, "fee_rate": FEE_RATE, "min_entry_usd": MIN_ENTRY_USD,
            "whales_tracked": len(whales), "whales_active": len(per),
            "whales_failed": failed, "history_cut": cut,
            "summary": summary,
            "by_category": {k: summarise(v) for k, v in sorted(cats.items())},
            "whales": whale_rows,
            "entries": rows,
            "exits_older": sorted(exits_by_day[d], key=lambda r: -r["ts"]),
            "settled": settled,
        }
        with open(os.path.join(out_dir, f"{d}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        index[d] = {"date": d, "generated_at": now_ts, "entries_complete": d < today,
                    "whales_active": len(per), **summary}

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": now_ts, "tz": "Asia/Kolkata", "stake_usd": STAKE_USD,
                   "min_entry_usd": MIN_ENTRY_USD, "refresh_days": REFRESH_DAYS,
                   "days": sorted(index.values(), key=lambda x: x["date"], reverse=True)},
                  f, separators=(",", ":"), ensure_ascii=False)
    t = index[today]
    log(f"  daily: today {t['entries']} entries, {t['closed']} closed, won {t['won']}, "
        f"copy P&L on closed ${t['copy_pnl_closed']:+,.0f} per ${STAKE_USD:.0f} copied")
    return {"today": today, "entries_today": t["entries"], "days_written": days}
