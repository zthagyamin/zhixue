from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import server  # noqa: E402


class LearningSessionAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.original_config = dict(server.CONFIG)
        server.CONFIG["learning_vault_root"] = str(self.vault)
        self.write("01 学习/学习计划/00 学习计划总览.md", "---\ntype: learning-plan\npriority:\n  - 完成当前课程\n---\n# 学习计划\n")

    def tearDown(self) -> None:
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)
        self.temp_dir.cleanup()

    def write(self, relative: str, content: str) -> Path:
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_learning_session_files_are_read_as_dashboard_activities(self) -> None:
        lines = [
            "---", "type: learning-session", "session_id: session-20260827-001", "session_date: 2026-08-27",
            "started_at: 2026-08-27T20:00:00+08:00", "ended_at: 2026-08-27T20:35:00+08:00", "status: recorded",
            "domain:", "  - course", "source_notes:", "  - \"[[01 学习/专项课程/Test/课程笔记/第01讲.md]]\"",
            "state_refs:", "  - \"[[01 学习/专项课程/Test/学习记录/第01讲 学习状态.md]]\"", "evidence_level: checked",
            "mapping_status: exact", "ability_ids:", "  - norm-purpose", "weak_abilities:", "  - 解释归一化的作用",
            "next_action: 在 2026-08-29 闭卷复测", "sync_status: local-recorded", "created: 2026-08-27",
            "updated: 2026-08-27", "tags:", "  - 学习/会话", "---", "", "# 学习会话 · 2026-08-27 · Test L01",
        ]
        self.write("_System/Integrations/Study Loop/sessions/2026/08/session-20260827-001.md", "\n".join(lines) + "\n")

        dashboard = server.daily_dashboard(date(2026, 8, 27))

        self.assertEqual(dashboard["activityCount"], 1)
        self.assertEqual(dashboard["activityMinutes"], 35)
        activity = dashboard["activities"][0]
        self.assertEqual(activity["eventId"], "learning-session:session-20260827-001")
        self.assertEqual(activity["activityType"], "learning-session")
        self.assertEqual(activity["domain"], "course")
        self.assertEqual(activity["title"], "学习会话 · 2026-08-27 · Test L01")
        self.assertEqual(activity["sourceNote"], "01 学习/专项课程/Test/课程笔记/第01讲.md")
        self.assertEqual(activity["stateRef"], "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md")
        self.assertEqual(activity["weakPoints"], ["解释归一化的作用"])

    def test_learning_session_duplicate_ids_are_deduplicated_and_bad_files_ignored(self) -> None:
        lines = [
            "---", "type: learning-session", "session_id: duplicate-session", "session_date: 2026-08-27",
            "started_at: 2026-08-27T09:00:00+08:00", "ended_at: 2026-08-27T09:10:00+08:00", "status: recorded",
            "domain:", "  - python", "source_notes: []", "state_refs: []", "evidence_level: activity-only",
            "mapping_status: unmapped", "ability_ids: []", "weak_abilities: []", "next_action: 继续练习",
            "sync_status: local-recorded", "---", "# A",
        ]
        session = "\n".join(lines) + "\n"
        self.write("_System/Integrations/Study Loop/sessions/2026/08/a.md", session)
        self.write("_System/Integrations/Study Loop/sessions/2026/08/b.md", session.replace("# A", "# B"))
        self.write("_System/Integrations/Study Loop/sessions/2026/08/not-a-session.md", "---\ntype: paper-reading-session\n---\n# Ignore\n")

        dashboard = server.daily_dashboard(date(2026, 8, 27))

        self.assertEqual(dashboard["activityCount"], 1)
        self.assertEqual(dashboard["activities"][0]["eventId"], "learning-session:duplicate-session")


if __name__ == "__main__":
    unittest.main()
