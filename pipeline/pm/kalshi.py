"""Kalshi client — the free, reachable place to rehearse the ORDER PATH.

WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
----------------------------------------
Kalshi's demo environment is a full clone of its production platform on mock
funds: same REST and WebSocket surface, separate credentials, no real money at
any point. Two properties make it worth having:

  1. IT IS REACHABLE FROM INDIA. Verified 2026-09-16 from a connection where
     Polymarket is sinkholed: demo-api.kalshi.co answers HTTP 200. Note the TLD
     -- demo.kalshi.co and demo-api.kalshi.co are on .co and resolve fine, while
     kalshi.com and docs.kalshi.com are sinkholed and time out. So you can use
     the sandbox but cannot read Kalshi's own documentation from the same box.
  2. IT COSTS NOTHING. Mock funds, no card, no subscription.

WHAT IT CANNOT DO -- and this is structural, not a gap to work around:

  KALSHI'S TRADE TAPE IS ANONYMOUS. Verified against the live demo API:
  GET /markets/trades returns ticker, price, count, timestamp and taker side,
  and NO trader identity of any kind. There is no wallet, no account id, no
  username. /leaderboard, /users, /portfolio/rankings, /social and /followers
  all return 404.

  So you CANNOT identify a skilled trader on Kalshi, and therefore cannot copy
  one. Copy trading is impossible here in principle, not merely unimplemented.
  Polymarket is the only venue of the two with per-trader attribution, because
  its fills settle on a public chain (see chain.py).

Use this module to prove the EXECUTION half works -- signing, order lifecycle,
rejections, partial fills, portfolio accounting, drawdown tripwires -- and use
chain.py for the SIGNAL half. They are different venues and the two halves do
not join up into a live copy-trading system on Kalshi.

AUTH
----
RSA-PSS. In the demo account settings you create an API key, which gives you a
key id and a downloaded private key PEM. Every request signs
    f"{timestamp_ms}{HTTP_METHOD}{path}"
with PSS padding, SHA-256 digest, salt length = digest length, and sends:
    KALSHI-ACCESS-KEY        the key id
    KALSHI-ACCESS-TIMESTAMP  the same millisecond timestamp
    KALSHI-ACCESS-SIGNATURE  base64 of the signature
The signed `path` includes the /trade-api/v2 prefix and EXCLUDES the query
string.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
import urllib.request
from typing import Any

DEMO = "https://demo-api.kalshi.co/trade-api/v2"
LIVE = "https://api.elections.kalshi.com/trade-api/v2"

DEMO_WS = "wss://demo-api.kalshi.co/trade-api/ws/v2"
LIVE_WS = "wss://api.elections.kalshi.com/trade-api/ws/v2"


class KalshiError(RuntimeError):
    pass


class Kalshi:
    """Thin client. Public endpoints need no credentials; portfolio and orders do.

    >>> k = Kalshi()                      # demo, unauthenticated
    >>> k.get("/markets", limit=3)        # works
    >>> k.get("/portfolio/balance")       # 401 until you pass key_id + key_pem
    """

    def __init__(self, key_id: str | None = None, private_key_pem: str | None = None,
                 *, base: str = DEMO, timeout: int = 30):
        self.base = base.rstrip("/")
        self.key_id = key_id
        self.timeout = timeout
        self._key = None
        if private_key_pem:
            try:
                from cryptography.hazmat.primitives import serialization
            except ImportError as e:  # pragma: no cover
                raise KalshiError("pip install cryptography to sign requests") from e
            self._key = serialization.load_pem_private_key(
                private_key_pem.encode() if isinstance(private_key_pem, str)
                else private_key_pem,
                password=None,
            )

    # ------------------------------------------------------------------ auth

    def _sign(self, method: str, path: str) -> dict:
        """Build the three auth headers. `path` must include /trade-api/v2 and
        must NOT include the query string."""
        if not (self.key_id and self._key):
            return {}
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        ts = str(int(time.time() * 1000))
        msg = f"{ts}{method.upper()}{path}".encode()
        sig = self._key.sign(
            msg,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                        salt_length=hashes.SHA256().digest_size),
            hashes.SHA256(),
        )
        return {
            "KALSHI-ACCESS-KEY": self.key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        }

    # ------------------------------------------------------------- transport

    def request(self, method: str, endpoint: str, *, body: dict | None = None,
                **params) -> Any:
        endpoint = "/" + endpoint.lstrip("/")
        # The signed path is the FULL path including the version prefix, without query.
        signed_path = urllib.parse.urlsplit(self.base).path + endpoint

        url = self.base + endpoint
        params = {k: v for k, v in params.items() if v is not None}
        if params:
            url += "?" + urllib.parse.urlencode(params)

        headers = {"Accept": "application/json",
                   "User-Agent": "polymarket-whale-lab/0.1"}
        headers.update(self._sign(method, signed_path))
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 401:
                raise KalshiError(
                    f"401 from {endpoint}. Unauthenticated, or the signature is wrong. "
                    f"Check that the signed path includes '/trade-api/v2' and EXCLUDES "
                    f"the query string, and that the timestamp is milliseconds. {detail}"
                ) from e
            raise KalshiError(f"HTTP {e.code} {endpoint}: {detail}") from e

    def get(self, endpoint: str, **params) -> Any:
        return self.request("GET", endpoint, **params)

    def post(self, endpoint: str, body: dict) -> Any:
        return self.request("POST", endpoint, body=body)

    # -------------------------------------------------------------- public

    def status(self) -> dict:
        return self.get("/exchange/status")

    def markets(self, limit: int = 100, **kw) -> list[dict]:
        return self.get("/markets", limit=limit, **kw).get("markets", [])

    def trades(self, limit: int = 100, **kw) -> list[dict]:
        """The public tape.

        WARNING: these trades carry NO trader identity -- only ticker, price,
        count, time and taker side. Do not build any follow/copy logic on this;
        there is nobody to follow. Verified: no leaderboard/users endpoint
        exists (all 404).
        """
        return self.get("/markets/trades", limit=limit, **kw).get("trades", [])

    def orderbook(self, ticker: str, depth: int = 10) -> dict:
        return self.get(f"/markets/{ticker}/orderbook", depth=depth)

    # ------------------------------------------------------------ authed

    def balance(self) -> dict:
        return self.get("/portfolio/balance")

    def positions(self, **kw) -> dict:
        return self.get("/portfolio/positions", **kw)

    def create_order(self, *, ticker: str, side: str, action: str, count: int,
                     order_type: str = "limit", price_cents: int | None = None,
                     client_order_id: str | None = None) -> dict:
        """Place an order. DEMO ONLY unless you deliberately constructed this
        client with base=LIVE — check `self.base` before calling in anger.

        side   'yes' | 'no'
        action 'buy' | 'sell'
        price_cents  1..99 for a limit order
        """
        body: dict[str, Any] = {
            "ticker": ticker, "side": side, "action": action,
            "count": count, "type": order_type,
            "client_order_id": client_order_id or f"wl-{int(time.time()*1000)}",
        }
        if order_type == "limit":
            if price_cents is None:
                raise KalshiError("limit order needs price_cents (1..99)")
            body["yes_price" if side == "yes" else "no_price"] = int(price_cents)
        return self.post("/portfolio/orders", body)

    def is_demo(self) -> bool:
        return "demo" in self.base


if __name__ == "__main__":
    k = Kalshi()
    st = k.status()
    print(f"demo exchange_active={st.get('exchange_active')} "
          f"trading_active={st.get('exchange_index_statuses', [{}])[0].get('trading_active')}")
    ts = k.trades(limit=5)
    print(f"\npublic tape, {len(ts)} trades — note the total absence of any trader field:")
    for t in ts[:3]:
        print(f"  {t['ticker']:<34} {t.get('yes_price_dollars')}  x{t.get('count_fp')}  "
              f"taker={t.get('taker_side')}")
    print(f"\n  fields present: {sorted(ts[0])}" if ts else "")
    try:
        k.balance()
        print("\nbalance: reachable unauthenticated (unexpected)")
    except KalshiError as e:
        print(f"\nbalance without credentials -> {str(e)[:70]}… (expected)")
