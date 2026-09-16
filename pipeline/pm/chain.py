"""Read the Polymarket fill tape straight off Polygon.

WHY THIS EXISTS
---------------
Polymarket's REST API is unreachable from networks that sinkhole the
polymarket.com DNS zone (several Indian ISPs now do). But Polymarket SETTLES on
Polygon, so the fills are public chain state and any Polygon RPC serves them.
Verified from a blocked connection, 2026-09-16: three public RPCs answered and
the v2 exchange returned 2,112 OrderFilled events in a 50-block window.

The chain is also the better source on the merits. It is the settlement truth,
it has no CDN cache (the REST endpoints are all `max-age=300`), and maker AND
taker are both indexed, so ONE topic filter isolates a single wallet's complete
fill history.

THREE TRAPS, ALL OF WHICH FAIL SILENTLY
---------------------------------------
1. THE V1 EXCHANGE IS DEAD. 0x4bFb41d5... is what most tutorials still cite. It
   returned ZERO events in a 50-block window where v2 returned 2,112. It does
   not error -- it returns an empty list forever. `assert_tape_alive()` exists
   to catch exactly this.
2. makerAssetId IS 0 OR 1, AND THE FIELD SEMANTICS FLIP BETWEEN THEM. A decoder
   that only handles 0 silently drops 13.6% of fills -- essentially the entire
   sell side. Measured over 3,744 fills: 3,235 were makerAssetId=0 and 509 were
   makerAssetId=1, and under the rule below 509/509 produce a valid price in
   (0,1] while the inverse reading produces 0/509.
3. UNKEYED PUBLIC RPCs CAP eth_getLogs AT ~50 BLOCKS. Ask for more and you get a
   truncated result or an error depending on the provider. Backfill needs a
   keyed endpoint (Alchemy/Infura/QuickNode free tiers are fine).
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Any, Iterator

# ---------------------------------------------------------------- constants

# CTF Exchange v2 — live. Migrated 2026-04-28.
EXCHANGE_V2 = "0xe111180000d2663c0091e4f400237545b87b996b"
# CTF Exchange v1 — DEAD. Kept only so callers can assert they are NOT using it.
EXCHANGE_V1_DEAD = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"

TOPIC_ORDER_FILLED = (
    "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"
)
# Emitted alongside the OrderFilled events of the same transaction. Counting
# both as trades double-counts; this module reads OrderFilled only.
TOPIC_ORDERS_MATCHED = (
    "0x174b3811690657c217184f89418266767c87e4805d09680c39fc9c031c0cab7c"
)

PUBLIC_RPCS = [
    "https://polygon.drpc.org",
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
    # NOT polygon-rpc.com -- returns "API key disabled, tenant disabled".
]

# USDC and Polymarket outcome shares are both 6-decimal.
DECIMALS = 1_000_000

MAX_PUBLIC_RANGE = 50   # blocks per eth_getLogs on an unkeyed endpoint

_HEADERS = {
    "Content-Type": "application/json",
    # Some public RPCs 403 a request with no User-Agent.
    "User-Agent": "polymarket-whale-lab/0.1",
    "Accept": "application/json",
}


class ChainError(RuntimeError):
    pass


# ------------------------------------------------------------------- client

class PolygonClient:
    """Minimal JSON-RPC client with endpoint rotation."""

    def __init__(self, rpcs: list[str] | None = None, timeout: int = 40):
        self.rpcs = list(rpcs or PUBLIC_RPCS)
        self.timeout = timeout
        self.keyed = bool(rpcs)   # a caller-supplied endpoint may allow wide ranges

    def call(self, method: str, params: list, *, retries: int = 3) -> Any:
        last: Exception | None = None
        for attempt in range(retries):
            for i, url in enumerate(list(self.rpcs)):
                try:
                    body = json.dumps(
                        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
                    ).encode()
                    req = urllib.request.Request(url, data=body, headers=_HEADERS)
                    with urllib.request.urlopen(req, timeout=self.timeout) as r:
                        out = json.loads(r.read())
                    if "error" in out:
                        raise ChainError(f"{url}: {out['error']}")
                    # rotate the winner to the front
                    if i:
                        self.rpcs.insert(0, self.rpcs.pop(i))
                    return out["result"]
                except Exception as e:  # noqa: BLE001 - try the next endpoint
                    last = e
            time.sleep(1.5 * (2 ** attempt))
        raise ChainError(f"all RPCs failed for {method}: {last}") from last

    def block_number(self) -> int:
        return int(self.call("eth_blockNumber", []), 16)

    def logs(self, from_block: int, to_block: int, *, address: str | None = None,
             topics: list | None = None) -> list[dict]:
        # Resolved at CALL time. A module-level default would be bound at import
        # and could not be overridden -- which is exactly how the first version
        # of assert_tape_alive silently checked the wrong address and passed.
        address = address or EXCHANGE_V2
        span = to_block - from_block + 1
        if not self.keyed and span > MAX_PUBLIC_RANGE:
            raise ChainError(
                f"{span}-block range on an unkeyed RPC; public endpoints cap "
                f"eth_getLogs at ~{MAX_PUBLIC_RANGE} blocks. Pass a keyed RPC "
                f"(Alchemy/Infura/QuickNode) or walk in chunks."
            )
        return self.call("eth_getLogs", [{
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
            "address": address,
            "topics": topics if topics is not None else [TOPIC_ORDER_FILLED],
        }])


# ------------------------------------------------------------------ decoder

def decode_fill(log: dict) -> dict | None:
    """Decode one OrderFilled log into a trade.

    Layout (3 indexed + 7 data words):
        topics[1] orderHash
        topics[2] maker
        topics[3] taker
        data[0]   makerAssetId       0 or 1 -- SEE BELOW
        data[1]   takerAssetId       the ERC1155 outcome tokenId
        data[2]   makerAmountFilled
        data[3]   takerAmountFilled
        data[4]   fee
        data[5..6] extra v2 words (data[5] non-zero on ~5% of fills)

    THE SIDE RULE, established empirically over 3,744 live fills:
        makerAssetId == 0 -> maker BUYS  : pays makerAmt USDC for takerAmt shares
        makerAssetId == 1 -> maker SELLS : gives makerAmt shares for takerAmt USDC
    Under this rule every observed fill prices inside (0, 1]; under the inverse,
    none of the makerAssetId==1 fills do. Handling only assetId 0 -- the obvious
    reading, and what most examples show -- silently discards 13.6% of the tape,
    which is almost exactly the sell side.
    """
    topics = log.get("topics") or []
    if len(topics) < 4:
        return None
    data = (log.get("data") or "0x")[2:]
    w = [int(data[i * 64:(i + 1) * 64], 16) for i in range(len(data) // 64)]
    if len(w) < 5:
        return None

    maker_asset, taker_asset, maker_amt, taker_amt, fee = w[0], w[1], w[2], w[3], w[4]

    if maker_asset == 0 and taker_asset != 0:
        side, usdc, shares, token_id = "BUY", maker_amt, taker_amt, taker_asset
    elif maker_asset == 1 and taker_asset != 0:
        side, usdc, shares, token_id = "SELL", taker_amt, maker_amt, taker_asset
    else:
        # Unrecognised shape. Do not guess -- surface it.
        return None

    if shares == 0:
        return None
    price = usdc / shares
    if not (0.0 < price <= 1.0 + 1e-9):
        return None

    return {
        "block": int(log["blockNumber"], 16),
        "tx": log.get("transactionHash"),
        "log_index": int(log.get("logIndex", "0x0"), 16),
        "order_hash": topics[1],
        # maker is the resting order; taker crossed the spread
        "maker": "0x" + topics[2][-40:],
        "taker": "0x" + topics[3][-40:],
        "side": side,                      # side FROM THE MAKER'S POINT OF VIEW
        "token_id": str(token_id),
        "price": round(price, 6),
        "shares": shares / DECIMALS,
        "usd": round(usdc / DECIMALS, 6),
        "fee": fee / DECIMALS,
    }


def fills(client: PolygonClient, from_block: int, to_block: int,
          *, wallet: str | None = None, address: str | None = None) -> Iterator[dict]:
    """Yield decoded fills. If `wallet` is given, filter on-chain by topic.

    maker and taker are BOTH indexed, so a single wallet's entire fill history
    comes back from two cheap topic-filtered queries rather than by scanning.
    """
    if wallet:
        padded = "0x" + wallet.lower().replace("0x", "").rjust(64, "0")
        queries = [
            [TOPIC_ORDER_FILLED, None, padded],        # as maker
            [TOPIC_ORDER_FILLED, None, None, padded],  # as taker
        ]
    else:
        queries = [[TOPIC_ORDER_FILLED]]

    seen: set = set()
    for topics in queries:
        for log in client.logs(from_block, to_block, topics=topics, address=address):
            t = decode_fill(log)
            if not t:
                continue
            key = (t["tx"], t["log_index"])
            if key in seen:
                continue
            seen.add(key)
            yield t


def assert_tape_alive(client: PolygonClient, *, blocks: int = 50,
                      min_fills: int = 1, address: str | None = None) -> int:
    """Fail loudly if the tape is empty.

    This guard exists because the dead v1 exchange returns an empty list forever
    without erroring -- a backtest built on it would look clean and be entirely
    hollow. Same silent-wrongness class as a wrong timezone map: every
    structural check passes and the data is simply absent.

    Call this before trusting ANY analysis built on the chain.
    """
    addr = address or EXCHANGE_V2
    if addr.lower() == EXCHANGE_V1_DEAD.lower():
        raise ChainError(
            f"Refusing to read {EXCHANGE_V1_DEAD}: this is the DEAD v1 exchange. "
            f"It returns an empty log list forever without erroring. Use "
            f"EXCHANGE_V2 ({EXCHANGE_V2})."
        )
    head = client.block_number()
    logs = client.logs(head - blocks + 1, head, address=addr)
    n = sum(1 for log in logs if decode_fill(log))
    if n < min_fills:
        raise ChainError(
            f"TAPE IS EMPTY: {n} decodable fills in the last {blocks} blocks at "
            f"{addr} (head {head:,}). Either the address is wrong (the dead v1 "
            f"{EXCHANGE_V1_DEAD} returns empty forever), the topic is wrong, or "
            f"the RPC is lying. Refusing to proceed."
        )
    return n


if __name__ == "__main__":
    c = PolygonClient()
    head = c.block_number()
    n = assert_tape_alive(c)
    print(f"head block {head:,} | tape alive: {n} decodable fills in 50 blocks")
    sample = list(fills(c, head - 20, head))
    buys = sum(1 for t in sample if t["side"] == "BUY")
    print(f"{len(sample)} fills decoded | {buys} BUY / {len(sample) - buys} SELL")
    for t in sorted(sample, key=lambda x: -x["usd"])[:5]:
        print(f"  ${t['usd']:>10,.2f} {t['side']:<4} @ {t['price']:.3f}  maker {t['maker'][:10]}…")
