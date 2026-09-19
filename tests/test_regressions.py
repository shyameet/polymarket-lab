import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
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


if __name__ == '__main__':
    unittest.main()
