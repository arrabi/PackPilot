import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("import_roster", Path(__file__).parents[1] / "scripts" / "import_roster.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportTests(unittest.TestCase):
    def test_phone_and_missing_values(self):
        self.assertEqual(module.normalize(1234567890.0, "parent_1_phone"), "1234567890")
        self.assertEqual(module.normalize("00123", "parent_1_phone"), "00123")
        self.assertIsNone(module.normalize("   ", "parent_1_name"))

    def test_dates_reject_ambiguity(self):
        self.assertEqual(module.normalize(dt.datetime(2018, 2, 1), "birth_date"), "2018-02-01")
        with self.assertRaises(ValueError):
            module.normalize("02/01/2018", "birth_date")
        with self.assertRaises(ValueError):
            module.normalize("2026-02-29", "birth_date")

    def test_sql_escapes_values_and_is_atomic(self):
        sql = module.build_sql("test.xlsx", "a" * 64, "2026-10-21", [{"scout_name": "O'Example; DROP TABLE scouts;--"}])
        self.assertIn("O''Example", sql)
        self.assertIn("begin;", sql)
        self.assertIn("commit;", sql)
        self.assertIn("on conflict (snapshot_id, source_row) do nothing", sql)
        self.assertIn("explicit replacement procedure required", sql)

class HealthExclusionTests(unittest.TestCase):
    def test_import_payload_never_preserves_health_values(self):
        payload = [{"scout_name": "Synthetic", "allergy": "secret-allergy", "medication": "secret-medication", "source_values": {"Allergy": "secret-allergy", "nested": {"Medical condition": "secret-condition"}, "Scout name": "Synthetic"}}]
        sql = module.build_sql("synthetic.xlsx", "b" * 64, "2026-11-02", payload)
        self.assertNotIn("secret-", sql)
        self.assertNotIn("allergy text", sql)
        self.assertIn("Synthetic", sql)

    def test_historical_health_columns_are_ignored_before_values_or_formulas(self):
        import tempfile
        workbook = module.openpyxl.Workbook()
        workbook.active.title = module.SHEET
        headers = list(module.MAPPING)
        offset = headers.index("DOB") + 1
        headers[offset:offset] = ["Allergy", "Medication"]
        workbook.active.append(headers)
        values = [None] * len(headers)
        values[headers.index("Scout name")] = "Synthetic"
        values[headers.index("Allergy")] = "secret-allergy"
        values[headers.index("Medication")] = '=1+1'
        workbook.active.append(values)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.xlsx'
            workbook.save(source)
            records, issues, warnings = module.extract(source, '2026-11-02')
        self.assertEqual(issues, [])
        self.assertNotIn('secret-', str(records))
        self.assertNotIn('Medication', str(records))


if __name__ == "__main__":
    unittest.main()
