"""Opaque local planning scope, independent of a changing lesson or content hash."""
import hashlib
import os
from pathlib import Path


def local_vault_library_id(root: Path) -> str | None:
    resolved = Path(root).resolve()
    if not resolved.is_dir():
        return None
    canonical = os.path.normcase(str(resolved))
    return 'local-vault:' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()
