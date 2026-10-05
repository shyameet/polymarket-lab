import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm import api, fund
from pm.fund import STAKE, START_CASH, fee, new_state, settle_and_mark, step, view

# 2026-09-23 00:00 IST = 2026-09-22 18:30 UTC
MIDNIGHT = 1790101800
T = MIDNIGHT + 3600
COND, COND2 = '0x' + 'a' * 64, '0x' + 'b' * 64
W1, W2, OUTSIDER = '0x' + '1' * 40, '0x' + '2' * 40, '0x' + '9' * 40
SIG = {W1, W2}


def fill(ts, side, size, price, wallet=W1, asset='T1', cond=COND, outcome='Team X'):
    return {'type': 'TRADE', 'timestamp': ts, 'side': side, 'size': size, 'price': price,
            'usdcSize': size * price, 'asset': asset, 'conditionId': cond, 'outcome': outcome,
            'title': 'Team X vs Team Y', 'slug': 'x-vs-y', 'wallet': wallet, 'name': 'whale'}


class Markets:
    """Fake CLOB: every market ends an hour after T unless told otherwise."""

    def __init__(self, end_ts=T + 3600):
        self.m = {c: {'tokens': {t: {'price': .5, 'winner': False} for t in toks},
                      'resolved': False, 'end_ts': end_ts}
                  for c, toks in ((COND, ('T1', 'T2')), (COND2, ('U1', 'U2')))}

    def __call__(self, cond):
        return self.m.get(cond)

    def resolve(self, cond, winner):
        for k, t in self.m[cond]['tokens'].items():
            t['winner'] = k == winner
            t['price'] = 1.0 if k == winner else 0.0
        self.m[cond]['resolved'] = True


def no_late(tok, ts):
    return None


def fresh():
    return new_state(T - 3600, [{'wallet': W1, 'name': 'one'}, {'wallet': W2, 'name': 'two'}])


def entry_cost(price):
    return STAKE + fee(STAKE / price, price)


class Signals(unittest.TestCase):
    def test_copies_at_the_fill_that_crosses_100(self):
        st = fresh()
        n = step(st, [fill(T, 'BUY', 150, .40), fill(T + 5, 'BUY', 100, .42)], SIG, Markets(), no_late)
        a = st['funds']['A']
        self.assertEqual(n, 1)
        self.assertEqual(len(a['open']), 1)
        p = a['open'][0]
        self.assertEqual((p['price'], p['ts'], p['whale_held']), (.42, T + 5, 250))
        self.assertAlmostEqual(p['shares'], STAKE / .42)
        self.assertAlmostEqual(a['cash'], START_CASH - entry_cost(.42))
        self.assertEqual(a['days']['2026-09-23']['copied'], 1)

    def test_under_100_or_an_unlisted_whale_is_not_copied(self):
        st = fresh()
        n = step(st, [fill(T, 'BUY', 100, .9), fill(T, 'BUY', 1000, .5, wallet=OUTSIDER)], SIG, Markets(), no_late)
        self.assertEqual(n, 0)
        self.assertEqual(st['funds']['A']['open'], [])

    def test_the_100_resets_at_india_midnight(self):
        st = fresh()
        step(st, [fill(MIDNIGHT - 10, 'BUY', 120, .5), fill(MIDNIGHT + 10, 'BUY', 120, .5)], SIG, Markets(), no_late)
        self.assertEqual(st['funds']['A']['open'], [])

    def test_one_signal_per_whale_outcome_and_day(self):
        st = fresh()
        n = step(st, [fill(T, 'BUY', 250, .4), fill(T + 60, 'BUY', 250, .4)], SIG, Markets(), no_late)
        self.assertEqual(n, 1)
        self.assertEqual(len(st['funds']['A']['open']), 1)

    def test_parlays_and_dust_prices_are_skipped(self):
        st = fresh()
        n = step(st, [fill(T, 'BUY', 500, .5, cond='0xshort'), fill(T, 'BUY', 200, .9995, asset='T2')],
                 SIG, Markets(), no_late)
        self.assertEqual(n, 0)
        self.assertEqual(st['funds']['A']['open'], [])

    def test_an_outcome_already_held_is_not_bought_twice(self):
        st = fresh()
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 30, 'BUY', 250, .41, wallet=W2)], SIG, Markets(), no_late)
        for code in ('A', 'B'):
            f = st['funds'][code]
            self.assertEqual([p['whale'] for p in f['open']], [W1])
            self.assertEqual(f['skipped_held'], 1)

    def test_no_cash_counts_a_miss(self):
        st = fresh()
        st['funds']['A']['cash'] = 5.0
        step(st, [fill(T, 'BUY', 250, .4)], SIG, Markets(), no_late)
        a = st['funds']['A']
        self.assertEqual((a['open'], a['missed_cash'], a['cash']), ([], 1, 5.0))
        self.assertEqual(a['days']['2026-09-23']['missed'], 1)
        self.assertEqual(len(st['funds']['B']['open']), 1)


class FundB(unittest.TestCase):
    def test_only_markets_ending_within_48_hours(self):
        for end, b_copies in ((T + 47 * 3600, True), (T + 49 * 3600, False), (None, False), (T - 60, True)):
            st = fresh()
            step(st, [fill(T, 'BUY', 250, .4)], SIG, Markets(end_ts=end), no_late)
            self.assertEqual(len(st['funds']['A']['open']), 1, end)
            self.assertEqual(len(st['funds']['B']['open']), int(b_copies), end)
            self.assertEqual(st['funds']['B']['skipped_filter'], int(not b_copies), end)

    def test_an_unknown_market_is_still_copied_by_a(self):
        st = fresh()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, lambda c: None, no_late)
        self.assertEqual(len(st['funds']['A']['open']), 1)
        self.assertEqual(st['funds']['B']['open'], [])


def titled(ts, title, asset, cond, **kw):
    return {**fill(ts, 'BUY', 250, .4, asset=asset, cond=cond, **kw), 'title': title, 'slug': ''}


def economics(f):
    """A fund's book without position ids, which count positions across all funds."""
    g = json.loads(json.dumps(f))
    for rec in g['open'] + g['closed']:
        rec.pop('id', None)
    return g


class FundC(unittest.TestCase):
    TOPICS = ['Bitcoin Up or Down - October 3, 9:00AM-9:05AM ET',      # crypto
              'Counter-Strike: Vitality vs NAVI (BO3)',                 # csgo
              'Valorant: Sentinels vs Fnatic',                          # valorant
              'Dota 2: Team Spirit vs Tundra - Game 1 Winner']          # esports

    def test_skips_crypto_and_esports_and_copies_the_rest(self):
        st = fresh()
        rows = [titled(T + i, t, f'X{i}', '0x' + str(i) * 64) for i, t in enumerate(self.TOPICS)]
        rows.append(fill(T + 9, 'BUY', 250, .4))                         # sports
        step(st, rows, SIG, lambda c: {'end_ts': T + 3600}, no_late)
        a, c = st['funds']['A'], st['funds']['C']
        self.assertEqual(len(a['open']), 5)
        self.assertEqual(([p['category'] for p in c['open']], c['skipped_filter']), (['sports'], 4))

    def test_a_fund_added_later_copies_only_after_it_opens(self):
        st = fresh()
        del st['funds']['C']                                             # a book saved before C existed
        self.assertEqual(fund.open_new_funds(st, T + 100), ['C'])
        self.assertEqual(fund.open_new_funds(st, T + 200), [])
        step(st, [fill(T + 50, 'BUY', 250, .4), fill(T + 300, 'BUY', 250, .4, asset='U1', cond=COND2)],
             SIG, Markets(), no_late)
        self.assertEqual([p['token'] for p in st['funds']['A']['open']], ['T1', 'U1'])
        c = st['funds']['C']
        self.assertEqual([p['token'] for p in c['open']], ['U1'])
        self.assertEqual((c['started'], c['points'], c['skipped_filter']), (T + 100, [[T + 100, START_CASH]], 0))
        self.assertAlmostEqual(c['cash'], START_CASH - entry_cost(.4))

    def test_adding_c_leaves_a_and_b_exactly_as_they_were(self):
        crypto = '0x' + 'c' * 64

        def run(with_c):
            st, m = fresh(), Markets()
            if not with_c:
                del st['funds']['C']
            m.m[crypto] = {'tokens': {'X1': {'price': .5, 'winner': False}}, 'resolved': False, 'end_ts': T + 3600}
            m.resolve(COND2, 'U1')
            st['cursor'] = T + 1000
            rows = [fill(T, 'BUY', 250, .4), titled(T + 5, self.TOPICS[0], 'X1', crypto),
                    fill(T + 10, 'BUY', 300, .5, asset='U1', cond=COND2, wallet=W2),
                    fill(T + 60, 'SELL', 100, .45), fill(T + 70, 'BUY', 300, .5, asset='T2', wallet=W2)]
            step(st, rows, SIG, m, lambda tok, ts: .5, {COND2: T + 200}.get, T + 1000)
            settle_and_mark(st, m, T + 1200, {COND2: T + 200}.get)
            return st

        with_c, without = run(True), run(False)
        self.assertGreater(len(with_c['funds']['C']['open']) + len(with_c['funds']['C']['closed']), 0)
        for code in ('A', 'B'):
            self.assertEqual(economics(with_c['funds'][code]), economics(without['funds'][code]), code)

    def test_the_page_gets_each_funds_opening_and_rules(self):
        st = fresh()
        del st['funds']['C']
        fund.open_new_funds(st, T + 100)
        v = view(st, T + 200)
        self.assertEqual(list(v['funds']), ['A', 'B', 'C'])
        self.assertEqual((v['funds']['A']['started'], v['funds']['C']['started']), (T - 3600, T + 100))
        self.assertEqual(v['rules']['funds']['C']['exclude'], ['crypto', 'csgo', 'valorant', 'esports'])
        self.assertEqual((v['rules']['funds']['B']['max_hours'], v['funds']['C']['name']),
                         (48, 'No crypto or esports'))


class FollowsTheWhale(unittest.TestCase):
    def test_sells_the_same_fraction_at_the_same_price(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .40)], SIG, m, no_late)
        step(st, [fill(T + 60, 'SELL', 125, .60)], SIG, m, no_late)
        a = st['funds']['A']
        self.assertAlmostEqual(a['open'][0]['left'], .5)
        step(st, [fill(T + 120, 'SELL', 125, .70)], SIG, m, no_late)
        self.assertEqual(a['open'], [])
        c = a['closed'][0]
        sh = STAKE / .4
        expect = (sh * .5 * .6 - fee(sh * .5, .6) + sh * .5 * .7 - fee(sh * .5, .7)
                  - STAKE - fee(sh, .4))
        self.assertAlmostEqual(c['pnl'], expect)
        self.assertEqual((c['how'], c['won'], c['close_ts'], c['sold_frac']), ('sold', True, T + 120, 1.0))
        self.assertAlmostEqual(c['exit'], .65)
        self.assertAlmostEqual(a['cash'], START_CASH + expect)

    def test_whale_adding_more_makes_a_later_sale_a_smaller_share(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 30, 'BUY', 250, .45), fill(T + 60, 'SELL', 250, .5)],
             SIG, m, no_late)
        self.assertAlmostEqual(st['funds']['A']['open'][0]['left'], .5)

    def test_selling_almost_everything_closes_the_copy(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 60, 'SELL', 247, .5)], SIG, m, no_late)
        self.assertEqual(st['funds']['A']['open'], [])
        self.assertEqual(st['funds']['A']['closed'][0]['how'], 'sold')

    def test_another_whale_selling_does_not_move_the_copy(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 60, 'SELL', 250, .5, wallet=W2)], SIG, m, no_late)
        self.assertEqual(st['funds']['A']['open'][0]['left'], 1.0)

    def test_buys_before_sells_within_one_second(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'SELL', 250, .5), fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        self.assertEqual(st['funds']['A']['closed'][0]['how'], 'sold')


class PayoutsInTheReplay(unittest.TestCase):
    """step() pays a settled market at the moment it closed, so the cash is back
    for the signals after it, as it would be for a bot watching live."""

    def test_a_payout_frees_cash_for_a_later_signal(self):
        st, m = fresh(), Markets()
        st['funds']['A']['cash'] = entry_cost(.4) + 1          # room for exactly one copy
        m.resolve(COND, 'T1')                                  # the first market closes at T+100
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 200, 'BUY', 300, .5, asset='U1', cond=COND2)],
             SIG, m, no_late, {COND: T + 100}.get, T + 1000)
        a = st['funds']['A']
        self.assertEqual(a['missed_cash'], 0)
        self.assertEqual([c['close_ts'] for c in a['closed']], [T + 100])
        self.assertEqual([p['token'] for p in a['open']], ['U1'])

    def test_without_the_payout_the_same_signal_is_missed(self):
        st, m = fresh(), Markets()
        st['funds']['A']['cash'] = entry_cost(.4) + 1
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 200, 'BUY', 300, .5, asset='U1', cond=COND2)],
             SIG, m, no_late, {COND: T + 100}.get, T + 1000)    # not settled: nothing comes back
        self.assertEqual(st['funds']['A']['missed_cash'], 1)

    def test_a_close_after_the_window_waits(self):
        st, m = fresh(), Markets()
        m.resolve(COND, 'T1')
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late, {COND: T + 2000}.get, T + 1000)
        self.assertEqual(len(st['funds']['A']['open']), 1)

    def test_the_whale_selling_before_the_close_comes_first(self):
        st, m = fresh(), Markets()
        m.resolve(COND, 'T2')
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 50, 'SELL', 250, .3)], SIG, m, no_late,
             {COND: T + 100}.get, T + 1000)
        c = st['funds']['A']['closed'][0]
        self.assertEqual((c['how'], len(st['funds']['A']['closed'])), ('sold', 1))

    def test_positions_from_earlier_runs_pay_out_inside_the_window(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        m.resolve(COND, 'T1')
        step(st, [], SIG, m, no_late, {COND: T + 500}.get, T + 1000)
        self.assertEqual(st['funds']['A']['closed'][0]['close_ts'], T + 500)


class Settlement(unittest.TestCase):
    def test_waits_until_the_replay_has_passed_the_close(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        st['cursor'] = T + 100
        m.resolve(COND, 'T1')
        a = st['funds']['A']
        self.assertEqual(settle_and_mark(st, m, T + 1000, {COND: T + 500}.get), 0)
        p = a['open'][0]
        self.assertEqual((p['mark'], p['resolved_seen']), (1.0, T + 1000))
        self.assertAlmostEqual(a['points'][-1][1], START_CASH - entry_cost(.4) + STAKE / .4, places=3)
        st['cursor'] = T + 600
        self.assertEqual(settle_and_mark(st, m, T + 2000, {COND: T + 500}.get), 3)   # A, B and C
        c = a['closed'][0]
        self.assertEqual((c['how'], c['payout'], c['close_ts']), ('settled', 1.0, T + 500))
        self.assertAlmostEqual(c['pnl'], STAKE / .4 - entry_cost(.4))
        self.assertAlmostEqual(a['cash'], START_CASH - entry_cost(.4) + STAKE / .4)
        self.assertEqual(a['days']['2026-09-23']['base'], .4)       # held to the end: the price paid

    def test_without_a_close_time_it_settles_the_run_after_it_was_seen(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        m.resolve(COND, 'T2')
        st['cursor'] = T + 100
        self.assertEqual(settle_and_mark(st, m, T + 1000, {}.get), 0)
        st['cursor'] = T + 1000
        self.assertEqual(settle_and_mark(st, m, T + 1600, {}.get), 3)               # A, B and C
        c = st['funds']['A']['closed'][0]
        self.assertEqual((c['payout'], c['won'], c['close_ts']), (0.0, False, T + 1000))
        self.assertAlmostEqual(c['pnl'], -entry_cost(.4))

    def test_a_sale_just_before_the_close_is_followed_not_held_to_zero(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        st['cursor'] = T + 100
        m.resolve(COND, 'T2')                       # closed at T+300, the copy lost
        settle_and_mark(st, m, T + 1000, {COND: T + 300}.get)
        st['cursor'] = T + 2000                      # the next run replays the whale's exit at T+200
        step(st, [fill(T + 200, 'SELL', 250, .3)], SIG, m, no_late, {COND: T + 300}.get, T + 2000)
        settle_and_mark(st, m, T + 2600, {COND: T + 300}.get)
        c = st['funds']['A']['closed'][0]
        self.assertEqual((c['how'], c['close_ts'], len(st['funds']['A']['closed'])), ('sold', T + 200, 1))
        sh = STAKE / .4
        self.assertAlmostEqual(c['pnl'], sh * .3 - fee(sh, .3) - entry_cost(.4))

    def test_sold_part_then_settled(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 200, .5), fill(T + 60, 'SELL', 50, .8)], SIG, m, no_late)
        m.resolve(COND, 'T1')
        st['cursor'] = T + 5000
        settle_and_mark(st, m, T + 6000, {COND: T + 4000}.get)
        c = st['funds']['A']['closed'][0]
        sh = STAKE / .5
        self.assertAlmostEqual(c['pnl'], sh * .25 * .8 - fee(sh * .25, .8) + sh * .75 - entry_cost(.5))
        self.assertEqual((c['sold_frac'], c['exit']), (.25, .8))

    def test_open_positions_are_marked_at_the_price(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
        m.m[COND]['tokens']['T1']['price'] = .55
        settle_and_mark(st, m, T + 100)
        self.assertAlmostEqual(st['funds']['A']['points'][-1][1],
                               START_CASH - entry_cost(.4) + STAKE / .4 * .55, places=3)

    def test_old_episodes_are_dropped(self):
        st = fresh()
        st['episodes'] = {f'{W1}|T1|2026-09-20': {}, f'{W1}|T1|2026-09-22': {}, f'{W1}|T1|2026-09-23': {}}
        settle_and_mark(st, Markets(), T)
        self.assertEqual(sorted(k[-10:] for k in st['episodes']), ['2026-09-22', '2026-09-23'])

    def test_only_the_latest_closed_trades_are_kept_in_full(self):
        st = fresh()
        st['funds']['A']['closed'] = [{'close_ts': i} for i in range(fund.KEEP_CLOSED + 5)]
        settle_and_mark(st, Markets(), T)
        kept = st['funds']['A']['closed']
        self.assertEqual((len(kept), kept[0]['close_ts']), (fund.KEEP_CLOSED, 5))


class LateAndView(unittest.TestCase):
    def test_a_minute_late_is_tracked_beside_the_same_second(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .40)], SIG, m, lambda tok, ts: .45)
        m.resolve(COND, 'T1')
        st['cursor'] = T + 9999
        settle_and_mark(st, m, T + 10000, {COND: T + 5000}.get)
        c = st['funds']['A']['closed'][0]
        self.assertAlmostEqual(c['late_pnl'], STAKE / .45 - entry_cost(.45))
        self.assertLess(c['late_pnl'], c['pnl'])

    def test_equity_is_start_plus_realized_plus_open(self):
        st, m = fresh(), Markets()
        step(st, [fill(T, 'BUY', 250, .4), fill(T + 10, 'BUY', 300, .5, asset='U1', cond=COND2, wallet=W2),
                  fill(T + 60, 'SELL', 100, .45)], SIG, m, lambda tok, ts: .5)
        m.resolve(COND2, 'U1')
        m.m[COND]['tokens']['T1']['price'] = .62
        st['cursor'] = T + 9999
        settle_and_mark(st, m, T + 10000, {COND2: T + 5000}.get)
        v = view(st, T + 10000)['funds']['A']
        self.assertEqual((v['open_n'], v['closed_n'], v['won']), (1, 1, 1))
        self.assertAlmostEqual(v['equity'] - START_CASH, v['realized'] + v['unrealized'], delta=.02)
        self.assertEqual(v['days'][0]['date'], '2026-09-23')
        self.assertEqual(v['days'][0]['copied'], 2)
        self.assertAlmostEqual(v['days'][0]['change'], v['pnl'], delta=.01)
        self.assertEqual([(c['category'], c['closed'], c['won']) for c in v['cats']], [('sports', 1, 1)])
        self.assertAlmostEqual(v['open'][0]['exit'], .45)


def counting(fn, calls):
    def wrapped(*key):
        calls.append(key)
        return fn(*key)
    return wrapped


class Run(unittest.TestCase):
    CARDS = [{'wallet': W1.upper().replace('0X', '0x'), 'name': 'one', 'verdict': 'CANDIDATE'},
             {'wallet': W2, 'name': 'two', 'verdict': 'CANDIDATE'},
             {'wallet': OUTSIDER, 'name': 'nope', 'verdict': 'RISKY'}]

    def setUp(self):
        # the fee rules and order books are network reads: no test touches the network
        for name, fake in (('_fee_schedules', lambda conds: {}), ('_books_now', lambda toks: {})):
            p = mock.patch.object(fund, name, fake)
            p.start()
            self.addCleanup(p.stop)

    def test_first_run_opens_the_funds_without_touching_the_network(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(fund, '_activity', side_effect=AssertionError('no fetch on day one')):
            out = fund.build_fund(self.CARDS, now_ts=T, out_dir=d, log=lambda m: None)
            self.assertEqual(out, {'A': START_CASH, 'B': START_CASH, 'C': START_CASH})
            st = json.loads(Path(d, 'state.json').read_text(encoding='utf-8'))
            self.assertEqual([w['wallet'] for w in st['whales']], [W1, W2])
            self.assertEqual(st['funds']['A']['points'], [[T, START_CASH]])
            pub = json.loads(Path(d, 'fund.json').read_text(encoding='utf-8'))
            self.assertEqual(pub['funds']['B']['equity'], START_CASH)

    def test_the_next_run_replays_the_window_and_moves_the_cursor(self):
        m = Markets()
        rows = {W1: [fill(T + 100, 'BUY', 250, .4)]}
        calls = []

        def activity(w, start, end):
            calls.append((w, start, end))
            return [r for r in rows.get(w, []) if start <= r['timestamp'] <= end], False

        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(fund, '_activity', activity), \
                mock.patch.object(fund, '_clob_market', m), \
                mock.patch.object(fund, '_price_later', no_late), \
                mock.patch.object(fund, '_closed_at', {}.get):
            fund.build_fund(self.CARDS, now_ts=T, out_dir=d, log=lambda m: None)
            fund.build_fund(self.CARDS[1:], now_ts=T + 3600, out_dir=d, log=lambda m: None)
            st = json.loads(Path(d, 'state.json').read_text(encoding='utf-8'))
        self.assertEqual({c[1:] for c in calls}, {(T + 1, T + 3600 - fund.LAG_S)})   # nothing before opening
        self.assertEqual(st['cursor'], T + 3600 - fund.LAG_S)
        self.assertEqual(len(st['funds']['A']['open']), 1)
        self.assertEqual([w['wallet'] for w in st['whales']], [W2])     # the list for the NEXT window
        self.assertEqual(st['last_run']['signals'], 1)

    def test_a_saved_book_without_c_gets_c_on_the_next_run(self):
        m = Markets()
        with tempfile.TemporaryDirectory() as d:
            st = fresh()
            del st['funds']['C']
            for f in st['funds'].values():
                f.pop('started')                                         # as saved before 2026-10-03
            st['cursor'] = T
            Path(d, 'state.json').write_text(json.dumps(st), encoding='utf-8')
            logs = []
            with mock.patch.object(fund, '_activity',
                                   lambda w, s, e: ([fill(T + 900, 'BUY', 250, .4)] if w == W1 else [], False)), \
                    mock.patch.object(fund, '_clob_market', m), \
                    mock.patch.object(fund, '_price_later', no_late), \
                    mock.patch.object(fund, '_closed_at', {}.get):
                fund.build_fund(self.CARDS, now_ts=T + 1600, out_dir=d, log=logs.append)
            after = json.loads(Path(d, 'state.json').read_text(encoding='utf-8'))
        self.assertTrue(any('opened fund C' in line for line in logs), logs)
        self.assertEqual(len(after['funds']['A']['open']), 1)              # A copied the fill at T+900
        self.assertEqual((after['funds']['C']['open'], after['funds']['C']['started']), ([], T + 1600))

    def test_a_run_soon_after_opening_has_no_window_yet(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(fund, '_activity', side_effect=AssertionError('nothing to read yet')), \
                mock.patch.object(fund, '_clob_market', Markets()), \
                mock.patch.object(fund, '_closed_at', {}.get):
            fund.build_fund(self.CARDS, now_ts=T, out_dir=d, log=lambda m: None)
            fund.build_fund(self.CARDS, now_ts=T + 300, out_dir=d, log=lambda m: None)
            st = json.loads(Path(d, 'state.json').read_text(encoding='utf-8'))
        self.assertEqual((st['cursor'], st['last_run']['fills']), (T, 0))

    def test_lookups_are_fetched_once_each_and_give_the_direct_result(self):
        m = Markets()
        m.resolve(COND, 'T1')
        fills = [fill(T, 'BUY', 250, .4), fill(T + 200, 'BUY', 300, .5, asset='U1', cond=COND2, wallet=W2),
                 fill(T + 260, 'SELL', 100, .55, asset='U1', cond=COND2, wallet=W2)]
        late = {('T1', T + 60): .41, ('U1', T + 260): .52, ('U1', T + 320): .5}
        mc, cc, lc = [], [], []
        direct = fresh()
        direct['cursor'] = T + 1000
        step(direct, fills, SIG, m, lambda *k: late.get(k), {COND: T + 100}.get, T + 1000)
        settle_and_mark(direct, m, T + 1600, {COND: T + 100}.get)
        st = fresh()
        st['cursor'] = T + 1000
        fund._replay(st, fills, SIG, T + 1000, T + 1600,
                     fund._Lookups(counting(m, mc)), fund._Lookups(counting({COND: T + 100}.get, cc)),
                     fund._Lookups(counting(lambda *k: late.get(k), lc)), workers=4)
        self.assertEqual(st['funds'], direct['funds'])
        for calls in (mc, cc, lc):
            self.assertEqual(len(calls), len(set(calls)))
        self.assertEqual(sorted(mc), [(COND,), (COND2,)])

    def test_a_rate_limit_is_waited_out_not_counted_as_a_failure(self):
        answers = [api.PolymarketError('HTTP Error 429: Too Many Requests')] * 2 + [{'ok': 1}]

        def flaky(cond):
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a

        look = fund._Lookups(flaky)
        with mock.patch.object(fund.time, 'sleep') as slept:
            self.assertEqual(look(COND), {'ok': 1})
            self.assertEqual(look(COND), {'ok': 1})                     # cached: no third call
        self.assertEqual((look.fails, slept.call_count), (0, 2))

    def test_an_unreadable_whale_the_fund_holds_keeps_the_window(self):
        m = Markets()

        def activity(w, start, end):
            raise api.PolymarketError('down')

        with tempfile.TemporaryDirectory() as d:
            st = fresh()
            step(st, [fill(T, 'BUY', 250, .4)], SIG, m, no_late)
            st['cursor'] = T + 50
            Path(d, 'state.json').write_text(json.dumps(st), encoding='utf-8')
            with mock.patch.object(fund, '_activity', activity), \
                    mock.patch.object(fund, '_clob_market', m), \
                    mock.patch.object(fund, '_closed_at', {}.get):
                fund.build_fund(self.CARDS[1:], now_ts=T + 3600, out_dir=d, log=lambda m: None)
            after = json.loads(Path(d, 'state.json').read_text(encoding='utf-8'))
        self.assertEqual(after['cursor'], T + 50)
        self.assertEqual([w['wallet'] for w in after['whales']], [W1, W2])
        self.assertEqual(len(after['funds']['A']['points']), 2)        # still marked and recorded


# owner, 2026-10-05: real fees and what an open bet would really sell for, from FEE_SWITCH_TS
S = fund.FEE_SWITCH_TS + 3600


def fresh_after_switch():
    return new_state(S - 3600, [{'wallet': W1, 'name': 'one'}, {'wallet': W2, 'name': 'two'}])


class RealFees(unittest.TestCase):
    def test_a_copy_after_the_switch_pays_its_markets_own_fee(self):
        for rate in (0.0, 0.04, 0.07):
            st = fresh_after_switch()
            step(st, [fill(S, 'BUY', 250, .4)], SIG, Markets(end_ts=S + 3600), no_late, fee_rates={COND: rate})
            p = st['funds']['A']['open'][0]
            self.assertAlmostEqual(p['fee'], rate * (STAKE / .4) * .4 * .6)
            self.assertEqual(p['fee_rate'], rate)
            self.assertAlmostEqual(st['funds']['A']['cash'], START_CASH - STAKE - p['fee'])

    def test_a_copy_before_the_switch_keeps_the_estimate_it_was_booked_with(self):
        st = fresh()
        step(st, [fill(T, 'BUY', 250, .4)], SIG, Markets(), no_late, fee_rates={COND: 0.0})
        p = st['funds']['A']['open'][0]
        self.assertAlmostEqual(p['fee'], fee(STAKE / .4, .4))
        self.assertNotIn('fee_rate', p)

    def test_a_market_whose_fee_rule_is_unknown_keeps_the_estimate_and_says_so(self):
        st = fresh_after_switch()
        step(st, [fill(S, 'BUY', 250, .4)], SIG, Markets(end_ts=S + 3600), no_late, fee_rates={})
        p = st['funds']['A']['open'][0]
        self.assertAlmostEqual(p['fee'], fee(STAKE / .4, .4))
        self.assertTrue(p['fee_est'])

    def test_a_sale_after_the_switch_pays_the_markets_fee(self):
        st = fresh_after_switch()
        step(st, [fill(S, 'BUY', 250, .4), fill(S + 60, 'SELL', 250, .5)], SIG, Markets(end_ts=S + 3600), no_late,
             fee_rates={COND: 0.0})
        c = st['funds']['A']['closed'][0]
        self.assertAlmostEqual(c['pnl'], (STAKE / .4) * .5 - STAKE)      # no fee either way in a fee-free market

    def test_an_open_bet_is_valued_at_what_it_would_sell_for(self):
        st = fresh_after_switch()
        m = Markets(end_ts=S + 3600)
        step(st, [fill(S, 'BUY', 250, .4)], SIG, m, no_late, fee_rates={COND: 0.05})
        p = st['funds']['A']['open'][0]
        books = {'T1': [[.45, 10.0], [.44, 1000.0]]}                   # quoted .5, but buyers pay .45 / .44
        settle_and_mark(st, m, S + 100, sell_value=lambda q: fund._sell_now(q, books))
        sh = STAKE / .4
        want = 10 * .45 - fee(10, .45, .05) + (sh - 10) * .44 - fee(sh - 10, .44, .05)
        self.assertAlmostEqual(p['mark'] * sh, want)
        self.assertEqual(p['quoted'], .5)
        self.assertAlmostEqual(st['funds']['A']['points'][-1][1], st['funds']['A']['cash'] + want, places=3)

    def test_no_buyers_count_zero_and_an_unread_book_keeps_a_recent_value(self):
        st = fresh_after_switch()
        m = Markets(end_ts=S + 3600)
        step(st, [fill(S, 'BUY', 250, .4)], SIG, m, no_late, fee_rates={COND: 0.0})
        p = st['funds']['A']['open'][0]
        settle_and_mark(st, m, S + 100, sell_value=lambda q: fund._sell_now(q, {'T1': []}))
        self.assertEqual(p['mark'], 0.0)                                 # nobody bidding: $0 until it settles
        settle_and_mark(st, m, S + 200, sell_value=lambda q: fund._sell_now(q, {'T1': [[.5, 1000.0]]}))
        self.assertAlmostEqual(p['mark'], .5)
        settle_and_mark(st, m, S + 300, sell_value=lambda q: None)        # book not readable: the last value stays
        self.assertAlmostEqual(p['mark'], .5)
        settle_and_mark(st, m, S + 200 + fund.BOOK_KEEP_S + 1, sell_value=lambda q: None)
        self.assertEqual(p['mark'], 0.0)                                 # ...but not for ever


if __name__ == '__main__':
    unittest.main()
