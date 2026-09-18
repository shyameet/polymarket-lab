"""Large stablecoin transfers on Ethereum -- a fund-movement heads-up, not a
copyable trade.

WHY THIS EXISTS
----------------
The owner asked to go beyond Polymarket for whale data -- specifically
whether Binance or a Whale-Alert-style crypto feed could work the same way.
Both were ruled out for the SAME model (a rankable trader you can copy),
for two different reasons, both verified live 2026-09-18:
  - Binance's public API is fully anonymous by design. /api/v3/trades has no
    account field, and there is an open, unresolved feature request on
    Binance's own developer forum asking for one -- centralized/KYC'd
    exchanges never expose trader identity, no paid tier changes that.
  - Whale Alert has no free API tier ($29.95-$699+/mo), and even paid it
    attributes to ENTITIES (exchanges, custodians), not individual traders
    with a track record -- "$10M moved to Coinbase", not "this wallet is
    profitable, follow them".

What IS free and public in the same on-chain, wallet-level spirit as
Polymarket is a large token transfer. It is a genuinely DIFFERENT kind of
signal though: there is no outcome, no price, nothing to mirror. A wallet
moving funds to an exchange might precede a sale, might be a treasury
rebalance, might be nothing. This module -- and the UI section it feeds --
says so plainly rather than dressing a transfer up as a trade signal.

DATA SOURCE
-----------
Blockscout's public Ethereum instance (eth.blockscout.com), NOT Etherscan.
Etherscan's Account Module (tokentx, getLogs -- the two ways to list a
token's transfers) went free-tier-paywalled in a July 2026 breaking change;
verified live that tokentx now 403s on a free key. Blockscout's REST v2 needs
NO key at all and returns richer data besides: GET /tokens/{contract}/
transfers gives the most recent transfers of a token network-wide (not
per-holder -- exactly the "what just moved" feed this needs), with each side
already labeled when Blockscout recognizes the address (exchange, DEX,
protocol). Verified live 2026-09-18: no key required, real recent transfers,
real labels ("PoolManager" etc.).

Contract addresses are confirmed live via Blockscout's own /search, not
trusted from memory -- a wrong address would silently track the wrong token.
"""

from __future__ import annotations

import datetime as dt
import json
import time
import urllib.parse
import urllib.request
from typing import Any

BLOCKSCOUT = "https://eth.blockscout.com/api/v2"
UA = "polymarket-whale-lab/0.1 (research; read-only)"

TOKENS = [
    {"symbol": "USDT", "contract": "0xdAC17F958D2ee523a2206206994597C13D831ec7"},
    {"symbol": "USDC", "contract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"},
]

# Floor for "whale-sized". Most raw transfers on the firehose are retail --
# under $1k -- so this is doing real filtering, not a formality. Verified
# live: at $500k this often finds nothing at all in a single poll (whale-sized
# transfers are real but sparse in any one ~100-row window) -- $250k still
# reads as genuinely large for a single transfer while actually showing up.
MIN_USD = 250_000
MAX_FLOWS = 60


def _get(path: str, *, retries: int = 3, timeout: int = 20) -> dict:
    url = f"{BLOCKSCOUT}{path}"
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            if attempt == retries - 1:
                break
            time.sleep(1.5 * (2 ** attempt))
    raise RuntimeError(f"GET {url} failed after {retries} tries: {last}")


# pages (~50 raw transfers each) per token per build. Whale-sized transfers
# are genuinely sparse -- verified live, back-to-back runs seconds apart found
# 1 qualifying USDT row, then 0 -- so a single page undersells how much is
# really happening; this is a deliberate width/cost tradeoff against a free,
# rate-limited public instance, not an arbitrary number.
PAGES_PER_TOKEN = 3


def _fetch_token(token: dict, *, log) -> list[dict]:
    rows: list[dict] = []
    params = ""
    for _ in range(PAGES_PER_TOKEN):
        try:
            body = _get(f"/tokens/{token['contract']}/transfers{params}")
        except Exception as e:  # noqa: BLE001 - one bad page must not kill the build
            log(f"  ! crypto_flows {token['symbol']}: {e}")
            break
        rows.extend(body.get("items") or [])
        nxt = body.get("next_page_params")
        if not nxt:
            break
        params = "?" + urllib.parse.urlencode(nxt)

    out: list[dict] = []
    for row in rows:
        total = row.get("total") or {}
        tok = row.get("token") or {}
        try:
            rate = float(tok.get("exchange_rate") or 0)
            decimals = int(total.get("decimals") or 0)
            raw = int(total.get("value") or 0)
        except (TypeError, ValueError):
            continue
        if not rate or not decimals:
            continue

        amount = raw / (10 ** decimals)
        usd = amount * rate
        if usd < MIN_USD:
            continue

        ts_str = (row.get("timestamp") or "").replace("Z", "+00:00")
        try:
            ts = int(dt.datetime.fromisoformat(ts_str).timestamp())
        except ValueError:
            continue

        frm, to = row.get("from") or {}, row.get("to") or {}
        out.append({
            "symbol": token["symbol"],
            "amount": round(amount, 2),
            "usd": round(usd, 2),
            "from": frm.get("hash") or "",
            "from_label": frm.get("name") or "",
            "to": to.get("hash") or "",
            "to_label": to.get("name") or "",
            "tx": row.get("transaction_hash") or "",
            "ts": ts,
        })

    log(f"  crypto_flows {token['symbol']:<4} -> {len(out)} transfers >= ${MIN_USD:,}")
    return out


def build_crypto_flows(*, now_ts: int, log=print) -> dict[str, Any]:
    flows: list[dict] = []
    for token in TOKENS:
        flows.extend(_fetch_token(token, log=log))
    flows.sort(key=lambda f: -f["ts"])
    flows = flows[:MAX_FLOWS]

    return {
        "generated_at": now_ts,
        "min_usd": MIN_USD,
        "flows": flows,
        "note": ("Large USDT/USDC transfers on Ethereum, from public on-chain data -- "
                 "not Polymarket, not a trade, nothing to copy. A wallet moving funds "
                 "might precede a sale, might be a treasury rebalance, might be "
                 "nothing. A heads-up about where liquidity is moving, not a signal."),
    }
