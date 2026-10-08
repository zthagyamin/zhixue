"""Native submission-time version metadata; never part of a V3 event core."""
from __future__ import annotations
import index_gateway as gateway
from account_sync_export import source_fingerprint
from account_sync_schema import study_hash
from assistance_schema import validate_native_binding

ROUTE_KEYS = ('itemId', 'subjectId', 'abilityId', 'sourceNote', 'stateRef', 'progressRef', 'recordsRoot', 'contentRoot', 'documentPath', 'signature', 'contentRef')


def binding_sources(vault, binding, cache=None):
    result = {}
    for ref in dict.fromkeys((binding['documentPath'], binding['sourceNote'])):
        if cache is not None and ref in cache:
            digest = cache[ref]
        else:
            path = gateway._path(vault, ref)
            digest = source_fingerprint(gateway._read(path).encode('utf-8'))
            if cache is not None:
                cache[ref] = digest
        result[ref] = digest
    return result


def binding_hash(vault, binding, cache=None):
    return study_hash(dict(schemaVersion=1, vault=str(gateway._resolved(vault)),
                           route={key: binding[key] for key in ROUTE_KEYS}, sources=binding_sources(vault, binding, cache)))


def admit_binding(vault, event, binding, raw):
    """Bad/missing auxiliary metadata must not prevent the old core admission."""
    if raw is None:
        return {}
    try:
        sidecar = validate_native_binding(raw)
        if sidecar['eventId'] != event['eventId'] or sidecar['coreHash'] != event['coreHash']:
            raise ValueError('wrong-attempt')
    except (ValueError, TypeError, KeyError):
        return {'assistanceBindingIssue': 'baseline-unverified'}
    if not binding:
        return {'assistanceBindingIssue': 'mapping-missing'}
    try:
        sources = binding_sources(vault, binding)
        if sidecar['contentHash'] != binding['signature'] or sidecar['localBindingHash'] != binding_hash(vault, binding, sources):
            return {'assistanceBindingIssue': 'source-changed'}
        return {'assistanceBinding': sidecar, 'assistanceSources': sources}
    except (ValueError, OSError, KeyError):
        return {'assistanceBindingIssue': 'source-missing'}
