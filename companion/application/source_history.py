"""Join original portable events to registered local history without rewriting cores."""
from __future__ import annotations


def collect_progress_records(catalog, account_id, *, lookup, read_records, conflict):
    roots, events = set(), {}
    for binding in [*catalog.get('recordRoots', []), *catalog.get('bindings', {}).values()]:
        if binding['recordsRoot'] in roots:
            continue
        roots.add(binding['recordsRoot'])
        for row in read_records(binding, account_id):
            event = row['event']
            previous = events.get(event['eventId'])
            if previous and previous['event']['coreHash'] != event['coreHash']:
                raise conflict()
            association = row.get('sourceAssociationV1')
            if association is not None:
                canonical = lookup(association.get('itemKey', '')) if isinstance(association, dict) else None
                if (not canonical or association.get('schemaVersion') != 1
                        or association.get('originalItemKey') != event.get('item', {}).get('key')
                        or association.get('contentHash') != canonical.get('signature')
                        or row.get('localContext', {}).get('abilityId') != canonical.get('abilityId')
                        or row.get('subjectId') != canonical.get('subjectId')):
                    continue
                events[event['eventId']] = row
            elif lookup(event.get('item', {}).get('key', '')):
                events[event['eventId']] = row
    return sorted(events.values(), key=lambda row: (row['event']['occurredAt'], row['event']['eventId']))
