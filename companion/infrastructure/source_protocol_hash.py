"""Internal source-ledger digest; portable V3 retains its existing core hash."""
import hashlib
from application.source_admission import canonical_json


def fingerprint(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()
