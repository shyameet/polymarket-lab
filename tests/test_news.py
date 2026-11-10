import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm import news
from pm.news import STAKE, START_CASH, classify, new_state, release_ts, step, top_wallets, walk

T0 = 1794300000
CID = '0x' + 'c' * 64
W, OTHER = '0x' + '1' * 40, '0x' + '2' * 40


def row(ts, side, size, price, wallet=W, tok='Y', tx=None):
    return {'timestamp': ts, 'side': side, 'size': size, 'price': price, 'proxy_wallet': wallet,
            'token_id': tok, 'condition_id': CID, 'transaction_hash': tx or f'tx{ts}{wallet[-1]}{side}',
            'title': 'Fed decision', 'outcome': 'Yes'}


class Markets:
    def __init__(self):
        self.m = {CID: {'tokens': {'Y': {'price': .6, 'winner': False}, 'N': {'price': .4, 'winner': False}},
                        'resolved': False, 'end_ts': T0 + 86400}}
        self.closed = {}

    def __call__(self, cid):
        return self.m.get(cid)

    def resolve(self, winner, at):
        for k, t in self.m[CID]['tokens'].items():
            t['winner'] = k == winner
        self.m[CID]['resolved'] = True
        self.closed[CID] = at


def fresh():
    s = new_state(T0)
    s['top'] = {CID: [W]}
    s['markets'] = {CID: {'event': 'Fed decision', 'slug': 'fed', 'title': 'Fed decision',
                          'labels': {'Y': 'Yes on No change', 'N': 'No on No change'}}}
    return s


class WalkTest(unittest.TestCase):
    def test_buy_walks_later_takers_and_skips_the_whale_and_other_side(self):
        takers = [row(T0 + 10, 'BUY', 100, .60, W, tx='whale'),        # the whale's own fill
                  row(T0 + 10, 'SELL', 100, .58, OTHER),               # a seller: not the ask
                  row(T0 + 12, 'BUY', 20, .61, OTHER),
                  row(T0 + 30, 'BUY', 100, .63, OTHER)]
        got = walk(takers, T0 + 10, 'whale', 'BUY', usd=STAKE)
        self.assertAlmostEqual(got['usd'], STAKE)
        # 20 shares at .61 ($12.20), the rest ($12.80) at .63
        self.assertAlmostEqual(got['shares'], 20 + 12.8 / .63)
        self.assertEqual(got['fills'], 2)
        self.assertEqual(got['last'], T0 + 30)

    def test_nothing_after_the_window_counts(self):
        takers = [row(T0 + 1, 'BUY', 1, .6, OTHER), row(T0 + news.NEXT_S + 1, 'BUY', 1000, .6, OTHER)]
        self.assertLess(walk(takers, T0, 'x', 'BUY', usd=STAKE)['usd'], STAKE)


class StepTest(unittest.TestCase):
    def run_step(self, s, fills, takers, mk, until):
        return step(s, fills, takers, mk, lambda c: mk.closed.get(c), until, {CID: 0.02})

    def test_copies_at_later_fills_not_the_whale_price_and_settles(self):
        s, mk = fresh(), Markets()
        whale = row(T0 + 100, 'BUY', 200, .50, tx='whale')            # $100: the signal
        takers = {'Y': [whale, row(T0 + 105, 'BUY', 500, .55, OTHER)]}
        self.assertEqual(self.run_step(s, [whale], takers, mk, T0 + 1000), 1)
        p = s['open'][0]
        self.assertAlmostEqual(p['price'], .55)
        self.assertAlmostEqual(p['whale_price'], .50)
        self.assertAlmostEqual(p['shares'], STAKE / .55)
        fee = .02 * p['shares'] * .55 * .45
        self.assertAlmostEqual(s['cash'], START_CASH - STAKE - fee)
        mk.resolve('Y', T0 + 2000)
        s['cursor'] = T0 + 1000
        self.run_step(s, [], {}, mk, T0 + 3000)
        self.assertEqual(s['open'], [])
        c = s['closed'][0]
        self.assertAlmostEqual(c['pnl'], STAKE / .55 - STAKE - fee)
        self.assertEqual(c['how'], 'settled')

    def test_missed_when_too_little_traded_after(self):
        s, mk = fresh(), Markets()
        whale = row(T0 + 100, 'BUY', 400, .50, tx='whale')
        takers = {'Y': [whale, row(T0 + 120, 'BUY', 10, .52, OTHER)]}   # only $5.20 traded after
        self.run_step(s, [whale], takers, mk, T0 + 1000)
        self.assertEqual(s['open'], [])
        self.assertEqual(s['counts']['missed_liquidity'], 1)
        self.assertEqual(s['cash'], START_CASH)

    def test_only_wallets_listed_before_the_window_are_copied(self):
        s, mk = fresh(), Markets()
        outsider = row(T0 + 100, 'BUY', 400, .50, OTHER, tx='o')
        takers = {'Y': [outsider, row(T0 + 105, 'BUY', 500, .55, W)]}
        self.assertEqual(self.run_step(s, [outsider], takers, mk, T0 + 1000), 0)
        self.assertEqual(s['open'], [])

    def test_follows_the_whale_out_into_later_sellers(self):
        s, mk = fresh(), Markets()
        buy = row(T0 + 100, 'BUY', 200, .50, tx='whale')
        sell = row(T0 + 500, 'SELL', 100, .70, tx='whale-out')          # sells half of what it bought
        takers = {'Y': [buy, row(T0 + 105, 'BUY', 500, .50, OTHER),
                        sell, row(T0 + 520, 'SELL', 1000, .68, OTHER)]}
        self.run_step(s, [buy, sell], takers, mk, T0 + 1000)
        p = s['open'][0]
        self.assertAlmostEqual(p['left'], .5)
        self.assertAlmostEqual(p['sales'][0]['price'], .68)
        self.assertAlmostEqual(p['sales'][0]['whale_price'], .70)

    def test_one_position_per_outcome(self):
        s, mk = fresh(), Markets()
        s['top'] = {CID: [W, OTHER]}
        a = row(T0 + 100, 'BUY', 400, .50, W, tx='a')
        b = row(T0 + 200, 'BUY', 400, .50, OTHER, tx='b')
        takers = {'Y': [a, b, row(T0 + 210, 'BUY', 1000, .55, '0x' + '3' * 40)]}
        self.run_step(s, [a, b], takers, mk, T0 + 1000)
        self.assertEqual(len(s['open']), 1)
        self.assertEqual(s['counts']['held'], 1)


class BoardTest(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify('Fed Decision in December?')['name'], 'Fed')
        self.assertEqual(classify('October Inflation US - Annual')['name'], 'CPI')
        self.assertIsNone(classify('How many Fed rate cuts in 2026?'))
        self.assertIsNone(classify('Germany GDP growth in Q3 2026'))
        self.assertIsNone(classify('Jerome Powell out of Fed Board by...?'))

    def test_release_time_from_rules_text(self):
        info = classify('ECB Interest Rates: October 2026')
        t = release_ts(info, 'meeting, scheduled for October 28-29, 2026, as listed', '2026-10-30T03:59:00Z')
        self.assertEqual(t, 1793279700)                   # 29 Oct 2026 14:15 Frankfurt (CET) = 13:15 UTC

    def test_top_wallets_skip_zero_cost_sinks_and_sum_the_event(self):
        h = {'c1': [{'token_id': 'Y', 'holders': [
                {'proxy_wallet': W, 'token_id': 'Y', 'amount': 100, 'avg_price': .4, 'current_price': .6,
                 'current_value': 60, 'total_pnl': 20},
                {'proxy_wallet': OTHER, 'token_id': 'Y', 'amount': 10 ** 6, 'avg_price': 0, 'current_value': 6e5}]}],
             'c2': [{'token_id': 'Z', 'holders': [
                {'proxy_wallet': W, 'token_id': 'Z', 'amount': 50, 'avg_price': .2, 'current_price': .3,
                 'current_value': 15, 'total_pnl': 5}]}]}
        top = top_wallets(h, {'Y': 'Yes on A', 'Z': 'Yes on B'})
        self.assertEqual([t['wallet'] for t in top], [W])
        self.assertEqual(top[0]['usd'], 75)
        self.assertEqual(top[0]['side'], 'Yes on A')


if __name__ == '__main__':
    unittest.main()
