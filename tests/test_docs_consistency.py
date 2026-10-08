import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import snapshot_schema  # noqa: E402


class DocsConsistencyTests(unittest.TestCase):
    def test_readme_links_preserved_legacy_sources_and_capture_details(self) -> None:
        readme = (ROOT / "companion" / "README.md").read_text(encoding="utf-8")
        self.assertIn("[LEGACY.md](LEGACY.md)", readme)
        legacy = (ROOT / "companion" / "LEGACY.md").read_text(encoding="utf-8")
        for token in ("sources", "approved", "pending", "rejected", "captureId", "itemId",
                      "explicit", "speculative", "sources/approved"):
            self.assertIn(token, legacy)

    def test_source_area_doc_documents_snapshot_semantics(self) -> None:
        doc = (ROOT / "docs" / "study-loop-source-area.md").read_text(encoding="utf-8")
        for token in ("approved", "pending", "rejected", "sources/", "snapshot"):
            self.assertIn(token, doc)

    def test_plan_base_view_doc_defines_derived_view(self) -> None:
        doc = (ROOT / "docs" / "learning-plan-base-view.md").read_text(encoding="utf-8")
        for token in ("学习计划.base", "itemId", "abilityId", "派生", "托管区"):
            self.assertIn(token, doc)
        self.assertIn("00 学习计划总览.md", doc)

    def test_docs_match_implemented_snapshot_schema_fields(self) -> None:
        # The base-view doc must agree with the fields the implementation
        # actually writes (snapshot_schema.REQUIRED_FIELDS in camelCase).
        expected = {field for field in snapshot_schema.REQUIRED_FIELDS}
        doc = (ROOT / "docs" / "learning-plan-base-view.md").read_text(encoding="utf-8")
        for field in expected:
            self.assertIn(field, doc)


if __name__ == "__main__":
    unittest.main()
