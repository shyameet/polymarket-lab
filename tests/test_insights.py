import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from pm.insights import build_insights, topic_profile


def position(size=10, status='OPEN', **extra):
    return dict(wallet='0xabc', condition='market-a', outcome='Yes', size=size,
                status=status, last_event_at=100, **extra)


def snapshot(ts, opened=(), closed=()):
    return dict(generated_at=ts, open=list(opened), recently_closed=list(closed))


class InsightsTests(unittest.TestCase):
    def test_absence_is_not_exit_and_nonadjacent_sizes_are_not_compared(self):
        a = build_insights(snapshot(100, [position()]))
        b = build_insights(snapshot(200), a)
        self.assertEqual(b['events'], [])
        c = build_insights(snapshot(300, [position(20)]), b)
        self.assertEqual(c['events'], [])

    def test_add_reduce_and_explicit_exit(self):
        a = build_insights(snapshot(100, [position()]))
        b = build_insights(snapshot(200, [position(15)]), a)
        self.assertEqual(b['events'][0]['kind'], 'added')
        c = build_insights(snapshot(300, [position(8)]), b)
        self.assertEqual(c['events'][0]['kind'], 'reduced')
        closed = position(8, 'CLOSED'); closed['last_event_at'] = 350
        d = build_insights(snapshot(400, closed=[closed]), c)
        self.assertEqual(d['events'][0]['kind'], 'exited')
        self.assertEqual(d['holdings']['0xabc']['median_observed_seconds'], 250)
        e = build_insights(snapshot(500, closed=[closed]), d)
        self.assertEqual(e['holdings']['0xabc']['completed_samples'], 1)

    def test_old_exit_and_opposite_outcome_never_close_current_position(self):
        a = build_insights(snapshot(200, [position()]))
        b = build_insights(snapshot(300, closed=[position(status='CLOSED')]), a)
        self.assertEqual(b['events'], [])
        p = position(status='CLOSED'); p.update(outcome='No', last_event_at=250)
        c = build_insights(snapshot(300, closed=[p]), a)
        self.assertEqual(c['events'], [])

    def test_opposite_outcomes_are_one_market_and_topics_use_their_own_pnl(self):
        rows = [dict(condition='same', category='weather', realized_pnl=10, cost_usd=20),
                dict(condition='same', category='weather', realized_pnl=-12, cost_usd=20),
                dict(condition='different', category='crypto', realized_pnl=1000, cost_usd=100)]
        topics = {t['category']: t for t in topic_profile(rows)['topics']}
        self.assertEqual(topics['weather']['markets'], 1)
        self.assertEqual(topics['weather']['pnl'], -2)
        self.assertFalse(topics['weather']['qualified'])

    def test_specialist_requires_sample_diversity_consistency_and_focus(self):
        import datetime as dt
        rows = [dict(condition=str(i), category='weather', realized_pnl=10, cost_usd=100,
                     last_event_at=dt.datetime(2026, 1+i%3, 15, tzinfo=dt.timezone.utc).timestamp())
                for i in range(24)]
        self.assertTrue(topic_profile(rows)['topics'][0]['specialist'])
        rows[0]['realized_pnl'] = 10000
        self.assertFalse(topic_profile(rows)['topics'][0]['qualified'])

    def test_no_holding_classification_from_first_observation(self):
        a = build_insights(snapshot(100, [position()]))
        h = a['holdings']['0xabc']
        self.assertEqual(h['classification'], 'unmeasured')
        self.assertIsNone(h['median_observed_seconds'])


if __name__ == '__main__':
    unittest.main()
