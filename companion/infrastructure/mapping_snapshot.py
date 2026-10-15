"""Byte snapshot of matched readable sources plus explicit unreadable states."""
import hashlib
import json
import vault_topology as topology


def capture(root, rules, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else []
    originals = {}
    for path, relative in topology.files(root, diagnostics):
        if not any(topology._matches(relative, rule['pathGlob']) for rule in rules):
            continue
        try:
            originals[relative] = path.read_bytes()
        except OSError:
            originals[relative] = None
            topology._diagnostic(diagnostics, 'mapping-unreadable-file', relative)
    return originals, diagnostics


def fingerprint(originals, diagnostics):
    rows = sorted([relative, hashlib.sha256(raw).hexdigest() if raw is not None else None] for relative, raw in originals.items())
    # Extraction adds encoding diagnostics; the byte hash already binds those.
    states = sorted({(row['code'], row['path']) for row in diagnostics if row['code'] in {'mapping-unreadable-file', 'mapping-unreadable-directory'}})
    return hashlib.sha256(json.dumps([rows, states], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def snapshot(root, rules):
    return fingerprint(*capture(root, rules))
