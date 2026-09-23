import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm import positions
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


if __name__ == '__main__':
    unittest.main()
