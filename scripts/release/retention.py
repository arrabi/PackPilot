"""Retention decisions are pure functions; only validated complete backups qualify."""
import calendar
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo('America/Los_Angeles')


def parse_time(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Backup timestamp must include a timezone')
    return value


def deadline(captured_at, scheduled=False):
    captured = parse_time(captured_at)
    local = captured.astimezone(PACIFIC)
    if scheduled and local.weekday() == 0:
        year = local.year + 1
        day = min(local.day, calendar.monthrange(year, local.month)[1])
        return local.replace(year=year, day=day).astimezone(timezone.utc)
    return captured.astimezone(timezone.utc) + timedelta(days=7)


def retained_ids(manifests, now):
    if now.tzinfo is None:
        raise ValueError('Current time must include timezone')
    valid = [m for m in manifests if m.get('status') == 'complete' and m.get('validated') is True]
    if not valid:
        return set()
    newest = max(valid, key=lambda m: parse_time(m['captured_at']))
    keep = {newest['id']}  # Never delete the last known-good recovery point.
    mondays = {}
    for manifest in valid:
        captured = parse_time(manifest['captured_at'])
        local = captured.astimezone(PACIFIC)
        if manifest.get('scheduled') is True and local.weekday() == 0:
            # One successful scheduled snapshot per Pacific Monday. Retain the
            # first one; later retries still receive the ordinary seven days.
            key = local.date()
            old = mondays.get(key)
            if old is None or captured < parse_time(old['captured_at']):
                mondays[key] = manifest
        if captured + timedelta(days=7) > now:
            keep.add(manifest['id'])
    for manifest in mondays.values():
        if deadline(manifest['captured_at'], True) > now:
            keep.add(manifest['id'])
    return keep
