import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('companion_architecture', Path(__file__).resolve().parents[1] / 'scripts/companion-architecture.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class CompanionArchitectureTests(unittest.TestCase):
    def codes(self, sources, manifest=None):
        return {item['code'] for item in checker.audit_sources(sources, list(sources) if manifest is None else manifest)['violations']}

    def test_pure_application_and_adapter_import_direction(self):
        self.assertEqual(self.codes({'application/a.py': 'from dataclasses import dataclass\n',
                                     'infrastructure/b.py': 'from application.a import dataclass\nimport sqlite3\n'}), set())
        self.assertIn('python-layer-direction', self.codes({'application/a.py': 'from infrastructure.b import store'}))

    def test_type_guard_does_not_hide_startup_or_database_imports(self):
        codes = self.codes({'application/a.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n import server\n import sqlite3\n'})
        self.assertTrue({'python-startup-import', 'python-layer-direction'} <= codes)

    def test_io_and_ambient_clock_fail_without_execution(self):
        code = 'from datetime import datetime\nopen("never-created", "w")\ndatabase.execute("never-run")\ndatetime.now()\n'
        self.assertTrue({'python-application-io', 'python-application-clock'} <= self.codes({'application/a.py': code}))

    def test_global_and_dynamic_lookup_are_not_ports(self):
        code = 'def bad(name):\n global STATE\n globals()[name]()\n getattr(services, name)()\n'
        self.assertTrue({'python-global-state', 'python-dynamic-code'} <= self.codes({'infrastructure/a.py': code}))

    def test_clock_import_aliases_cannot_bypass_injection(self):
        for code in ['from datetime import datetime as Clock\nClock.now()',
                     'import datetime\ndatetime.datetime.now()',
                     'import datetime as dt\ndt.date.today()']:
            with self.subTest(code=code):
                self.assertIn('python-application-clock', self.codes({'application/a.py': code}))

    def test_missing_program_and_stale_manifest_fail(self):
        self.assertEqual(self.codes({'application/a.py': ''}, ['infrastructure/missing.py']),
                         {'python-manifest-missing', 'python-manifest-stale'})

    def test_lines_and_bytes_have_independent_budgets(self):
        self.assertIn('python-module-size', self.codes({'application/a.py': '# line\n' * 451}))
        self.assertIn('python-module-size', self.codes({'application/a.py': '# ' + 'x' * 32001}))

    def test_relative_import_cycle_is_detected(self):
        self.assertIn('python-runtime-cycle', self.codes({'application/a.py': 'from .b import b', 'application/b.py': 'from .a import a'}))

    def test_fixed_exception_metadata_is_allowed_but_dynamic_import_is_not(self):
        self.assertEqual(self.codes({'application/a.py': 'getattr(error, "no_write", False)'}), set())
        self.assertIn('python-dynamic-code', self.codes({'infrastructure/a.py': 'import importlib\nimportlib.import_module(name)'}))
