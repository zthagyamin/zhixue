from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import audit_diag  # noqa: E402


class AuditDiagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.integration = self.vault / "_System/Integrations/Study Loop"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write(self, relative: str, content: str = "x") -> Path:
        path = self.integration / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_empty_vault_reports_zeros(self) -> None:
        report = audit_diag.audit_area(self.vault)
        self.assertEqual(report["sourcesFiles"], 0)
        self.assertEqual(report["derivedFiles"], 0)
        self.assertEqual(report["eventFiles"], 0)
        self.assertEqual(report["eventBytes"], 0)

    def test_distinguishes_real_sources_from_derived_and_events(self) -> None:
        self.write("sources/知学资料.md", "# 词卡")
        self.write("plan/调度状态/2026-08-25.md", "plan")
        self.write("plan/revisions.jsonl", "{}")
        self.write("学习记录/2026-08.md", "summary")
        self.write("events/2026/2026-08-25.jsonl", '{"eventId":"a"}\n')
        self.write("events/2026/2026-08-26.jsonl", '{"eventId":"b"}\n')
        report = audit_diag.audit_area(self.vault)
        self.assertEqual(report["sourcesFiles"], 1)
        self.assertEqual(report["derivedFiles"], 3)  # plan + 学习记录
        self.assertEqual(report["eventFiles"], 2)
        self.assertGreater(report["eventBytes"], 0)
        self.assertFalse(report["overgrown"])

    def test_event_growth_flags_potential_bloat(self) -> None:
        for day in range(1, 106):
            self.write(f"events/2026/evt-{day:03d}.jsonl", "x")
        report = audit_diag.audit_area(self.vault)
        self.assertTrue(report["overgrown"])
        self.assertGreaterEqual(report["eventFiles"], 100)

    def test_archived_events_are_counted_separately(self) -> None:
        self.write("events/archive/2026-07/2026-07-15.jsonl", "{}")
        report = audit_diag.audit_area(self.vault)
        self.assertEqual(report["archivedEventFiles"], 1)
        self.assertEqual(report["eventFiles"], 0)


if __name__ == "__main__":
    unittest.main()
