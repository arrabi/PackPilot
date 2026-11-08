import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('inventory_import',ROOT/'scripts/import_inventory.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class InventoryImportTests(unittest.TestCase):
 def test_synthetic_inventory_keeps_unknowns_zeroes_and_excludes_worksheet_totals(self):
  path=ROOT/'resources/synthetic-inventory.csv';plan=module.prepare(path)
  commands=[e['command'] for e in plan['entries']]
  self.assertEqual(len(commands),4);self.assertEqual(sum(c.get('quantity',0) for c in commands),7)
  self.assertEqual(sum('quantity' not in c for c in commands),1)
  self.assertEqual(sum(c.get('quantity')==0 for c in commands),1)
  self.assertEqual(len(set(c['item_id'] for c in commands)),4)
  self.assertEqual(plan,module.prepare(path));self.assertEqual(plan['excluded_worksheet_rows'],[6])
  self.assertEqual(commands[0]['counted_on'],'2000-01-09')
