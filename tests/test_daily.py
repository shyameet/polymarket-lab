import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm import daily
from pm.daily import entries_for_wallet, settle, summarise, token

# 2026-09-23 00:00 IST = 2026-09-22 18:30 UTC
MIDNIGHT = 1790101800


def fill(ts, side, size, price, asset='A', cond='C1', title='Team X vs Team Y'):
    return {'type': 'TRADE', 'timestamp': ts, 'side': side, 'size': size, 'price': price,
            'usdcSize': size * price, 'asset': asset, 'conditionId': cond,
            'outcome': 'Team X', 'title': title, 'slug': 'x-vs-y'}


class DayBoundary(unittest.TestCase):
    def test_india_midnight_splits_days(self):
        self.assertEqual(daily.ist_day(MIDNIGHT - 1), '2026-09-22')
        self.assertEqual(daily.ist_day(MIDNIGHT), '2026-09-23')
        self.assertEqual(daily.day_start('2026-09-23'), MIDNIGHT)
        self.assertEqual(daily.shift_day('2026-09-01', -1), '2026-08-31')


class Entries(unittest.TestCase):
    def test_same_day_buys_are_one_entry_at_vwap(self):
        ents, older = entries_for_wallet([fill(MIDNIGHT + 60, 'BUY', 100, .40),
                                          fill(MIDNIGHT + 120, 'BUY', 300, .60)])
        self.assertEqual(len(ents), 1)
        self.assertEqual(ents[0]['fills'], 2)
        self.assertAlmostEqual(ents[0]['entry'], (40 + 180) / 400)
        self.assertEqual(older, [])

    def test_buys_on_two_india_days_are_two_entries(self):
        ents, _ = entries_for_wallet([fill(MIDNIGHT - 60, 'BUY', 100, .5),
                                      fill(MIDNIGHT + 60, 'BUY', 100, .5)])
        self.assertEqual([e['day'] for e in ents], ['2026-09-22', '2026-09-23'])

    def test_sell_closes_the_oldest_entry_first_and_spills_to_older(self):
        ents, older = entries_for_wallet([
            fill(MIDNIGHT - 60, 'BUY', 100, .5),       # yesterday
            fill(MIDNIGHT + 60, 'BUY', 100, .6),       # today
            fill(MIDNIGHT + 600, 'SELL', 150, .7),     # closes all of yesterday's, half of today's
            fill(MIDNIGHT + 900, 'SELL', 80, .8),      # the other 50 of today's, 30 unmatched
        ])
        y, t = ents
        self.assertAlmostEqual(y['sold'], 100)
        self.assertAlmostEqual(t['sold'], 100)
        self.assertAlmostEqual(t['exit'], (50 * .7 + 50 * .8) / 100)
        self.assertEqual(len(older), 1)
        self.assertAlmostEqual(older[0]['shares'], 30)

    def test_non_trade_rows_are_ignored(self):
        ents, _ = entries_for_wallet([{**fill(MIDNIGHT, 'BUY', 100, .5), 'type': 'REDEEM'},
                                      {**fill(MIDNIGHT, 'BUY', 0, .5)}])
        self.assertEqual(ents, [])


def entry(shares=100, price=.4, sold=0.0, sold_usd=0.0):
    e = {'asset': 'A', 'shares': shares, 'usd': shares * price, 'entry': price,
         'sold': sold, 'sold_usd': sold_usd, 'exit': sold_usd / sold if sold else None}
    return e


def market(price, winner=False, resolved=False):
    return {'resolved': resolved, 'tokens': {'A': {'price': price, 'winner': winner}}}


class Settle(unittest.TestCase):
    def test_held_to_a_win(self):
        s = settle(entry(), market(1, winner=True, resolved=True))
        self.assertEqual((s['state'], s['status'], s['closed']), ('settled', 'won', True))
        self.assertAlmostEqual(s['whale_pnl'], 100 * (1 - .4))
        fee_in = daily.fee(250, .4)
        self.assertAlmostEqual(s['copy_pnl'], 250 * 1 - fee_in - 100)
        self.assertAlmostEqual(s['baseline'], .4)   # held: the price was the no-skill chance

    def test_held_to_a_loss(self):
        s = settle(entry(), market(0, resolved=True))
        self.assertEqual(s['status'], 'lost')
        self.assertAlmostEqual(s['whale_pnl'], -40)

    def test_open_is_never_a_win_or_a_loss(self):
        s = settle(entry(), market(.55))
        self.assertEqual((s['status'], s['closed'], s['baseline']), ('open', False, None))
        self.assertAlmostEqual(s['whale_pnl'], 100 * (.55 - .4))

    def test_decided_price_counts_before_the_winner_flag(self):
        s = settle(entry(), market(.996))
        self.assertEqual((s['state'], s['value'], s['status']), ('decided', 1.0, 'won'))

    def test_sold_out_is_judged_on_the_sale_with_a_coin_baseline(self):
        s = settle(entry(sold=100, sold_usd=35), None)
        self.assertEqual((s['state'], s['status'], s['baseline']), ('sold', 'lost', .5))
        self.assertAlmostEqual(s['whale_pnl'], -5)

    def test_unknown_market_is_not_scored(self):
        s = settle(entry(), None)
        self.assertEqual((s['status'], s['whale_pnl'], s['copy_pnl']), ('unknown', None, None))

    def test_combo_is_listed_but_never_scored(self):
        e = {**entry(), 'condition': '0x' + '3' * 62, 'outcome': '',
             'title': 'LoL: A vs B AND LoL: C vs D'}
        self.assertTrue(daily.is_combo(e))
        s = settle(e, None)
        self.assertEqual((s['state'], s['status'], s['whale_pnl']), ('combo', 'unknown', None))
        self.assertFalse(daily.is_combo({**e, 'condition': '0x' + '3' * 64, 'outcome': 'Yes',
                                         'title': 'Will it rain?'}))

    def test_settled_binary_market_answers_for_the_other_side(self):
        m = {'resolved': True, 'tokens': {'B': {'price': 1.0, 'winner': True}}}
        self.assertEqual(token(m, 'A'), {'price': 0.0, 'winner': False})
        self.assertIsNone(token({'resolved': False, 'tokens': {'B': {'price': .5, 'winner': False}}}, 'A'))


class Summary(unittest.TestCase):
    def test_win_rate_sits_beside_the_price_baseline(self):
        rows = [dict(usd=100, closed=True, status='won', baseline=.8, copy_pnl=20, whale_pnl=20),
                dict(usd=100, closed=True, status='lost', baseline=.6, copy_pnl=-60, whale_pnl=-60),
                dict(usd=100, closed=False, status='open', baseline=None, copy_pnl=5, whale_pnl=5)]
        s = summarise(rows)
        self.assertEqual((s['closed'], s['won'], s['lost'], s['open']), (2, 1, 1, 1))
        self.assertAlmostEqual(s['win_rate'], .5)
        self.assertAlmostEqual(s['baseline'], .7)
        self.assertAlmostEqual(s['copy_pnl_closed'], -40)
        self.assertAlmostEqual(s['copy_pnl_open'], 5)


if __name__ == '__main__':
    unittest.main()
