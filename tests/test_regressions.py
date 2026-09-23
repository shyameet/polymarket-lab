import json
import math
import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm import feed, positions
from pm.score import score_wallet
from pm.positions import _normalize


class RegressionTests(unittest.TestCase):
    def test_losing_wallet_is_not_worth_following(self):
        now = 1789833446
        points = [{'timestamp': now - (90-i)*86400, 'position_pnl': -i*10}
                  for i in range(90)]
        card = score_wallet({'all_time_pnl': {'trade_count': 1000,
                            'position_pnl': -890}}, points, now_ts=now)
        self.assertTrue(card['rankable'])
        self.assertEqual(card['verdict'], 'NOT COPYABLE')

    def test_closed_cost_uses_lifetime_size_not_zero_remaining_basis(self):
        row = _normalize({'avg_price': 0.4, 'total_size': 1000,
                          'entry_cost_usdc': 0}, {'wallet': 'test'}, 'CLOSED')
        self.assertEqual(row['cost_usd'], 400)

    def test_explicit_total_cost_takes_precedence(self):
        row = _normalize({'avg_price': 0.4, 'total_size': 1000,
                          'total_cost_usdc': 390}, {'wallet': 'test'}, 'CLOSED')
        self.assertEqual(row['cost_usd'], 390)

    def test_closed_sample_is_newest_first_not_biggest_winners(self):
        # The API's default CLOSED order is realized-PnL descending, which made
        # the 200-row sample each wallet's best trades: 100% "profitable".
        calls = []

        def fake(wallet, **kw):
            calls.append(kw)
            return []

        original = positions.api.user_positions
        positions.api.user_positions = fake
        try:
            positions._wallet_positions('0xabc')
        finally:
            positions.api.user_positions = original
        closed = next(k for k in calls if k.get('status') == 'CLOSED')
        self.assertEqual((closed.get('sort_by'), closed.get('sort_direction')),
                         ('TIMESTAMP', 'DESC'))

    # Winners are redeemed into CLOSED; $0 losers stay OPEN + redeemable forever.
    def test_unredeemed_losers_count_as_settled_losses_within_the_window(self):
        closed = [{'condition_id': f'c{i}', 'last_event_at': 1000 + i, 'realized_pnl': 10,
                   'avg_price': .5, 'total_size': 20}
                  for i in range(positions.TOPIC_CLOSED_SAMPLE)]
        lost = {'avg_price': .4, 'current_size': 100, 'unrealized_pnl': -40, 'redeemable': True}
        resolved = [{**lost, 'condition_id': 'in-window', 'last_event_at': 1500},
                    {**lost, 'condition_id': 'before-window', 'last_event_at': 900}]
        rows = positions._settled_unredeemed(resolved, closed, {'wallet': 'w'})
        self.assertEqual([r['condition'] for r in rows], ['in-window'])
        self.assertEqual(rows[0]['realized_pnl'], -40)

    def test_resolved_positions_are_not_live_holdings_and_failures_get_no_profile(self):
        dead = {'condition_id': 'over', 'redeemable': True, 'current_value': 0,
                'avg_price': .4, 'current_size': 500, 'unrealized_pnl': -200, 'last_event_at': 5}
        live = {'condition_id': 'live', 'current_value': 300, 'avg_price': .4,
                'current_size': 500, 'last_event_at': 5}
        results = {'0xok': ([dead, live], [], []), '0xfail': ([live], [], None)}
        original = positions._wallet_positions
        positions._wallet_positions = lambda w: results[w]
        try:
            cards = [{'wallet': w, 'verdict': 'CANDIDATE'} for w in results]
            out = positions.build_positions(cards, workers=1, now_ts=10, log=lambda *_: None)
        finally:
            positions._wallet_positions = original
        self.assertEqual({p['condition'] for p in out['open']}, {'live'})
        self.assertEqual(set(out['topic_profiles']), {'0xok'})
        self.assertEqual(out['coverage']['closed_failed'], 1)

    # Gamma answers a whole batch of REPEATED condition_ids in one call, but
    # closed=false drops a market once it resolves, so dates need both passes.
    # (Through the relay the batch looks like ONE market: it keeps only the last
    # value of a repeated param. That is the relay, not Gamma.)
    def test_every_feed_condition_gets_its_end_date(self):
        markets = {f'0x{i:064x}': (i % 3 == 0, f'2026-10-{i % 28 + 1:02d}T12:00:00Z')
                   for i in range(120)}   # id -> (resolved?, endDate)
        combo = 'f' * 64                  # synthetic parlay id: no market, no date
        urls = []

        class Reply:
            def __init__(self, body): self.body = json.dumps(body).encode()
            def read(self): return self.body
            def __enter__(self): return self
            def __exit__(self, *exc): return False

        def gamma(req, timeout=None):
            urls.append(req.full_url)
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
            closed = q['closed'] == ['true']
            return Reply({'markets': [{'conditionId': c, 'endDate': markets[c][1]}
                                      for c in q.get('condition_ids', [])
                                      if c in markets and markets[c][0] == closed]})

        original = feed.api.urllib.request.urlopen
        feed.api.urllib.request.urlopen = gamma
        try:
            out = feed._end_dates(set(markets) | {combo}, log=lambda *_: None)
        finally:
            feed.api.urllib.request.urlopen = original
        self.assertEqual(out, {c: end for c, (_, end) in markets.items()})
        # one request per batch of ids, per closed state -- not one per market
        self.assertEqual(len(urls), 2 * math.ceil((len(markets) + 1) / feed._END_DATE_BATCH))


if __name__ == '__main__':
    unittest.main()
