# Fictional roster format

synthetic-roster.csv contains two invented records and the exact supported non-health column order. It is a format example, not an import of a real roster. The importer consumes Excel, not CSV. To try it locally:

```bash
mkdir -p .local
python - <<'PY'
import csv
from openpyxl import Workbook
book = Workbook()
book.active.title = 'Roster 2026-27'
with open('examples/synthetic-roster.csv', newline='') as source:
    for row in csv.reader(source):
        book.active.append(row)
book.save('.local/synthetic-roster.xlsx')
PY
python scripts/import_roster.py --help
```

Keep actual workbooks, generated SQL and import reports in ignored .local/. Explicitly map your private source to this column order and sheet name. Dates must be Excel dates or ISO strings. Health fields are not imported. Review validation results before applying SQL to your own intended project.
