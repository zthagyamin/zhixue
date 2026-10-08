from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import plan_authority  # noqa: E402


def candidate(plan_hash: str = "a" * 64) -> dict:
    return {
        "day": "2026-08-25",
        "planHash": plan_hash,
        "items": [{"kind": "review", "itemKey": "word-1", "domain": "ielts", "estimatedMinutes": 8}],
        "totalMinutes": 8,
        "overloaded": False,
        "skipped": [],
    }


class PlanAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.plan_path = self.vault / "01 学习/学习计划/00 学习计划总览.md"
        self.plan_path.parent.mkdir(parents=True)
        self.plan_path.write_text("# 学习计划总览\n\n这是我的长期说明。\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_apply_plan_updates_only_managed_block_and_is_readable(self) -> None:
        path = plan_authority.apply_current_plan(self.vault, candidate(), revision=3)
        content = path.read_text(encoding="utf-8")
        self.assertIn("这是我的长期说明。", content)
        self.assertIn(plan_authority.PLAN_BEGIN, content)
        self.assertIn("word-1", content)
        current = plan_authority.read_current_plan(self.vault)
        self.assertEqual(current["revision"], 3)
        self.assertEqual(current["candidate"]["planHash"], "a" * 64)

    def test_first_managed_write_creates_backup(self) -> None:
        plan_authority.apply_current_plan(
            self.vault,
            candidate(),
            revision=1,
            now=datetime(2026, 8, 25, 6, 7, 8, tzinfo=timezone.utc),
        )
        backup = self.vault / "_System/Integrations/Study Loop/backups/20260825T060708Z/01 学习/学习计划/00 学习计划总览.md"
        self.assertEqual(backup.read_text(encoding="utf-8"), "# 学习计划总览\n\n这是我的长期说明。\n")

    def test_managed_write_preserves_crlf_outside_the_block(self) -> None:
        original = b"# \xe5\xad\xa6\xe4\xb9\xa0\xe8\xae\xa1\xe5\x88\x92\xe6\x80\xbb\xe8\xa7\x88\r\n\r\nuser text\r\n"
        self.plan_path.write_bytes(original)
        plan_authority.apply_current_plan(self.vault, candidate(), revision=1)
        written = self.plan_path.read_bytes()
        self.assertIn(b"user text\r\n", written)
        self.assertNotIn(b"user text\n", written.replace(b"user text\r\n", b""))

    def test_migrates_latest_legacy_revision_without_deleting_legacy(self) -> None:
        legacy = self.vault / "_System/Integrations/Study Loop/plan"
        legacy.mkdir(parents=True)
        rows = [
            {"revision": 1, "after": candidate("a" * 64)},
            {"revision": 2, "after": candidate("b" * 64)},
        ]
        (legacy / "revisions.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

        result = plan_authority.migrate_plan(
            self.vault,
            legacy,
            datetime(2026, 8, 25, 7, 0, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(result.status, "migrated")
        self.assertEqual(plan_authority.read_current_plan(self.vault)["candidate"]["planHash"], "b" * 64)
        self.assertTrue((legacy / "revisions.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
