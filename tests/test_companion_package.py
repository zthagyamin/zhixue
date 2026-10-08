from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PUBLISHED_ARCHIVE = PROJECT_ROOT / "public" / "downloads" / "zhixue-companion-windows.zip"


class PublishedCompanionArchiveTests(unittest.TestCase):
    def test_published_archive_can_import_server(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zhixue-published-import-") as temporary:
            extract_root = Path(temporary)
            with zipfile.ZipFile(PUBLISHED_ARCHIVE) as archive:
                archive.extractall(extract_root)

            package_root = extract_root / "zhixue-companion"
            script = f"import sys; sys.path.insert(0, {str(package_root)!r}); import server"
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", script],
                cwd=package_root,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
