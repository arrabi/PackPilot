import importlib.util
from pathlib import Path
import unittest
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'scripts/release/retention.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def manifest(id, time, scheduled=False, **kwargs):
    return dict(id=id, captured_at=time, scheduled=scheduled, status='complete', validated=True, **kwargs)


class RetentionTests(unittest.TestCase):
    def test_pacific_monday_boundary(self):
        self.assertEqual(r.deadline('2026-11-02T07:59:59Z', True), r.parse_time('2026-11-09T07:59:59Z'))
        self.assertEqual(r.deadline('2026-11-02T08:00:00Z', True), r.parse_time('2027-11-02T07:00:00Z'))

    def test_manual_monday_is_only_seven_days(self):
        self.assertEqual(r.deadline('2026-11-02T08:00:00Z'), r.parse_time('2026-11-09T08:00:00Z'))

    def test_twelve_calendar_months_including_leap_day(self):
        # February 29 was a Monday in 2016; calendar anniversary clamps to Feb 28.
        self.assertEqual(r.deadline('2016-02-29T18:00:00Z', True), r.parse_time('2017-02-28T18:00:00Z'))

    def test_deduplicates_monday_and_preserves_last_recovery_point(self):
        items = [manifest('first', '2026-11-02T09:00:00Z', True),
                 manifest('retry', '2026-11-02T10:00:00Z', True),
                 manifest('manual', '2026-11-02T11:00:00Z'),
                 manifest('newest', '2026-11-04T11:00:00Z')]
        self.assertEqual(r.retained_ids(items, r.parse_time('2026-12-01T00:00:00Z')), {'first', 'newest'})
        self.assertEqual(r.retained_ids(items, r.parse_time('2028-01-01T00:00:00Z')), {'newest'})

    def test_incomplete_and_unvalidated_backups_never_replace_last_good(self):
        items = [manifest('good', '2026-11-02T09:00:00Z')]
        items += [dict(id='failed', captured_at='2026-12-01T10:00:00Z', status='failed', validated=False)]
        self.assertEqual(r.retained_ids(items, r.parse_time('2026-12-02T00:00:00Z')), {'good'})
        with self.assertRaises(ValueError):
            r.parse_time('2026-11-01T00:00:00')


if __name__ == '__main__':
    unittest.main()
