"""Evidence for topic specialists and position changes, never invented certainty.

WHY THIS EXISTS
Category membership is not category performance. Aggregate CLOSED position PnL
by condition before scoring topics; opposite outcomes are one market, not two
independent wins. The input is capped, so every result is a sampled record.

Positions disappearing from the top-12 snapshot are NOT exits. Only explicit
CLOSED records confirm exits. Quantity differences are net inventory changes,
not proof of directional conviction (transfers/conversions can also move size).

Holding spans start at our first OPEN observation, not the true entry. Gaps
can conceal close/reopen cycles; never claim continuous holding or label a
whale a scalper or settlement holder from these observations.
"""
from __future__ import annotations

import collections
import datetime as dt
import math
import statistics


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else 0.0
    except (TypeError, ValueError):
        return 0.0


def position_key(p):
    if not p.get('condition') or not p.get('wallet') or not p.get('outcome'):
        return None
    return '|'.join((p['wallet'].lower(), p['condition'].lower(), p['outcome']))


def topic_profile(rows, *, capped=False):
    markets = {}
    for p in rows:
        cid = p.get('condition')
        if not cid or p.get('likely_hedge_residue'):
            continue
        key = (p.get('category', 'other'), cid)
        m = markets.setdefault(key, {'pnl': 0, 'cost': 0, 'ts': 0})
        m['pnl'] += number(p.get('realized_pnl'))
        m['cost'] += number(p.get('cost_usd'))
        m['ts'] = max(m['ts'], number(p.get('last_event_at')))
    grouped = collections.defaultdict(list)
    for (category, _), m in markets.items():
        grouped[category].append(m)
    total_cost = sum(m['cost'] for m in markets.values())
    topics = []
    for category, ms in grouped.items():
        pnl = sum(m['pnl'] for m in ms)
        cost = sum(m['cost'] for m in ms)
        gross_wins = sum(max(0, m['pnl']) for m in ms)
        concentration = max((max(0, m['pnl']) for m in ms), default=0) / gross_wins if gross_wins else 1
        months = collections.defaultdict(float)
        for m in ms:
            if m['ts']:
                months[dt.datetime.fromtimestamp(m['ts'], dt.timezone.utc).strftime('%Y-%m')] += m['pnl']
        positive = sum(v > 0 for v in months.values())
        qualified = (category != 'other' and len(ms) >= 20 and pnl > 0 and cost > 0
                     and len(months) >= 3 and positive / len(months) >= .6
                     and concentration <= .35)
        topics.append({'category': category, 'markets': len(ms), 'pnl': round(pnl, 2),
                       'cost': round(cost, 2), 'roi': round(pnl/cost, 4) if cost else None,
                       'wins': sum(m['pnl'] > 0 for m in ms),
                       'months': len(months), 'positive_months': positive,
                       'concentration': round(concentration, 4),
                       'qualified': qualified,
                       'specialist': qualified and total_cost > 0 and cost/total_cost >= .6})
    return {'topics': sorted(topics, key=lambda t: -t['pnl']),
            'sampled_closed_positions': len(rows), 'capped': capped}


def build_insights(positions, previous=None):
    previous = previous or {}
    now = positions['generated_at']
    prior_at = number(previous.get('generated_at'))
    old = previous.get('observations', {})
    # Keep first observations through temporary absence from a capped snapshot.
    observations = {k: v for k, v in old.items() if now-number(v.get('seen_at')) <= 90*86400}
    events = [e for e in previous.get('events', []) if now-number(e.get('observed_at')) <= 30*86400]
    spans = [s for s in previous.get('holding_spans', []) if now-number(s.get('at')) <= 90*86400]
    keys = {e['id'] for e in events}
    open_keys = {position_key(p) for p in positions.get('open', [])}
    for p in positions.get('open', []) + positions.get('recently_closed', []):
        key = position_key(p)
        if not key:
            continue
        before = observations.get(key)
        kind = None
        if p['status'] == 'OPEN':
            size = number(p.get('size'))
            # Only adjacent observations support a net-change comparison.
            if before and before.get('status') == 'OPEN' and before['seen_at'] == prior_at:
                delta = size - before['size']
                if abs(delta) > .0001:
                    kind = 'added' if delta > 0 else 'reduced'
            else:
                delta = None
            first = before['first_seen'] if before and before.get('status') == 'OPEN' else now
            observations[key] = {'wallet': p['wallet'], 'status': 'OPEN', 'size': size,
                                 'seen_at': now, 'first_seen': first}
        else:
            if key in open_keys:
                continue  # separately cached OPEN/CLOSED responses can disagree
            if not before or before.get('status') != 'OPEN':
                continue
            exited_at = number(p.get('last_event_at'))
            if not before['seen_at'] <= exited_at <= now:
                continue
            kind, delta = 'exited', -before['size']
            spans.append({'wallet': p['wallet'], 'seconds': exited_at-before['first_seen'],
                          'at': now, 'key': key})
            observations[key] = {**before, 'status': 'CLOSED', 'seen_at': now}
        if kind:
            eid = f'{key}|{now}|{kind}'
            if eid not in keys:
                events.append({'id': eid, 'wallet': p['wallet'], 'name': p.get('name'),
                               'condition': p['condition'], 'outcome': p['outcome'],
                               'title': p.get('title'), 'slug': p.get('slug'), 'category': p.get('category'),
                               'kind': kind, 'delta_shares': round(delta, 4),
                               'previous_shares': before['size'], 'observed_at': now,
                               'since': before['seen_at'], 'event_at': p.get('last_event_at')})
                keys.add(eid)
    holdings = {}
    for wallet in {s['wallet'] for s in spans} | {v['wallet'] for v in observations.values()}:
        completed = [s['seconds'] for s in spans if s['wallet'] == wallet]
        current = [now-v['first_seen'] for v in observations.values()
                   if v['wallet'] == wallet and v['status'] == 'OPEN' and v['seen_at'] == now]
        holdings[wallet] = {'completed_samples': len(completed),
                            'median_observed_seconds': statistics.median(completed) if completed else None,
                            'longest_current_seconds': max(current) if current else None,
                            'classification': 'unmeasured', 'settlement_status': 'unknown'}
    return {'generated_at': now, 'profiles': positions.get('topic_profiles', {}),
            'coverage': positions.get('coverage', {}), 'holdings': holdings,
            'events': sorted(events, key=lambda e: -e['observed_at'])[:1000],
            'observations': dict(sorted(observations.items(), key=lambda x: -x[1]['seen_at'])[:30000]),
            'holding_spans': sorted(spans, key=lambda s: -s['at'])[:5000],
            'note': 'Closed-result sample, not lifetime topic equity. Observation spans do not establish continuous holding. No inferred exits from disappearance.'}
