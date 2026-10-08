"""Versioned Shanghai learning day; raw timestamps and calendar audit paths stay intact."""
from datetime import date, datetime, timedelta, timezone
import re
from zoneinfo import ZoneInfo

LOCAL_TZ = timezone(timedelta(hours=8))
START_HOUR = 4
FIRST_EXTENDED_DAY = date(2026, 9, 22)
EFFECTIVE_AT = datetime(2026, 9, 22, 4, tzinfo=LOCAL_TZ)
CAPABILITY = 'study-day-4am-v1'

def _instant(value):
    moment = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
    # Legacy injected clock objects are Shanghai wall time; serialized instants require a zone.
    if isinstance(value, datetime) and moment.tzinfo is None:
        moment = moment.replace(tzinfo=LOCAL_TZ)
    if not isinstance(moment, datetime) or moment.tzinfo is None:
        raise ValueError('invalid-study-time')
    return moment.astimezone(LOCAL_TZ)

def study_day(value):
    moment = _instant(value)
    return (moment - timedelta(hours=START_HOUR) if moment >= EFFECTIVE_AT else moment).date()

def study_day_bounds(value):
    day = date.fromisoformat(value) if isinstance(value, str) else value
    if type(day) is not date:
        raise ValueError('invalid-study-day')
    def start(day):
        return datetime.combine(day, datetime.min.time(), LOCAL_TZ) + timedelta(hours=START_HOUR if day > FIRST_EXTENDED_DAY else 0)
    return start(day), start(day + timedelta(days=1))

def recorded_day_matches(value, declared):
    return declared in (study_day(value).isoformat(), _instant(value).date().isoformat())

def source_review_due_at(value):
    if not isinstance(value, str):
        return value
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2})T00:00:00\+08:00', value)
    if not match:
        return value
    day = date.fromisoformat(match[1])
    return f'{day.isoformat()}T04:00:00+08:00' if day > FIRST_EXTENDED_DAY else value


def current_study_day():
    return study_day(datetime.now(LOCAL_TZ))

def calendar_day(value):
    # Archive paths keep the original civil date, including historical timezone rules.
    moment = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
    return moment.astimezone(ZoneInfo('Asia/Shanghai')).date()
