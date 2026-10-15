"""Ordinary numeric-reference limits; no provider, model or real learning data."""
import copy
import hashlib
import json
import sqlite3
import unittest
from contextlib import closing
import test_companion
import practice_engine
import test_pm_route_compatibility as route_fixtures


class LegacyCalculationUndeterminedTests(unittest.TestCase):
    def test_unsupported_reference_is_unknown_without_a_rating_or_mutation(self):
        for reference in ("1/2","2/D_in",None,{"value":2}):
            with self.subTest(reference=reference):
                item = {"questionType":"calculation","prompt":"计算给定条件下的结果。",
                        "answer":reference,"explanation":"完整参考保留在原题。"}
                before = copy.deepcopy(item)
                result = practice_engine.grade_answer(item,"0.5",ai_available=False)
                self.assertIsNone(result["correct"])
                self.assertEqual(result["verdict"],"unknown")
                self.assertEqual(result["source"],"deterministic")
                self.assertNotIn("rating",result)
                self.assertNotIn("aiFallback",result)
                self.assertEqual(item,before)

    def test_unreadable_input_is_unknown_and_finite_results_still_use_tolerance(self):
        item = {"questionType":"calculation","prompt":"计算 1/2 的数值。","answer":"0.5"}
        for answer in ("1/2","",None,{"step":"1/2"}):
            with self.subTest(answer=answer):
                result = practice_engine.grade_answer(item,answer,ai_available=False)
                self.assertEqual(result["verdict"],"unknown")
                self.assertIsNone(result["correct"])
                self.assertNotIn("rating",result)
        self.assertEqual(practice_engine.grade_answer(item,"0.5000001")["verdict"],"correct")
        self.assertEqual(practice_engine.grade_answer(item,"0.75")["verdict"],"wrong")

    def test_real_handler_returns_unknown_without_formal_events(self):
        harness = route_fixtures.RouteCompatibilityTests()
        harness.setUp()
        try:
            database = route_fixtures.server.LOCAL_DATABASE_PATH.resolve()
            transient = {database,database.with_name(database.name+"-wal"),database.with_name(database.name+"-shm")}
            def files():
                return {path.relative_to(harness.fixture.vault).as_posix():path.read_bytes()
                        for path in harness.fixture.vault.rglob("*") if path.is_file() and path.resolve() not in transient}
            def records():
                with closing(sqlite3.connect(database)) as db:
                    names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
                    data = {name:db.execute('SELECT * FROM "'+name.replace('"','""')+'"').fetchall()
                            for name in names if name not in ("companion_sessions","study_ai_settings")}
                    # Reading settings may create its empty schema; no config change.
                    settings = db.execute("SELECT * FROM study_ai_settings").fetchall() if "study_ai_settings" in names else []
                    return hashlib.sha256(json.dumps([data,settings],sort_keys=True).encode()).hexdigest()
            before,before_records = files(),records()
            status,_,body = harness.request("POST","/v1/practice/grade",{
                "item":{"questionType":"calculation","prompt":"计算 1/2 的数值。","answer":"1/2"},
                "answer":"0.5"})
            self.assertEqual(status,200)
            self.assertEqual(body["verdict"],"unknown")
            self.assertIsNone(body["correct"])
            self.assertNotIn("rating",body)
            self.assertEqual(before,files())
            self.assertEqual(before_records,records())
        finally:
            harness.tearDown()

    def test_explicit_self_assessment_and_quiz_keep_their_existing_contract(self):
        self.assertEqual(practice_engine.grade_answer({"questionType":"flashcard","explanation":"one point"},"")["verdict"],
                         "self-assess")
        self.assertEqual(practice_engine.grade_answer({"questionType":"word","word":"term","meaning":"词义"},"")["verdict"],
                         "self-assess")
        self.assertEqual(practice_engine.grade_answer({"questionType":"quiz","answer":1},1)["verdict"],"correct")


if __name__=="__main__":
    unittest.main()
