"""Validate the local roster and prepare a private, atomic SQL import.

Read-only with respect to the workbook. Never uploads data or prints record values.
Requires openpyxl (available in the bundled Python runtime).
"""
import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import json
import re
from pathlib import Path
import sys

import openpyxl

SHEET = "Roster 2026-27"
MAPPING = {
    "Scout name": "scout_name", "den": "den", "den leader(s)": "den_leaders",
    "present last year": "present_last_year", "Parent 1": "parent_1_name",
    "Participant: Email address": "participant_email", "email 1": "parent_1_email",
    "Tel 1": "parent_1_phone", "Parent 2": "parent_2_name", "Email 2": "parent_2_email",
    "Tel 2": "parent_2_phone", "DOB": "birth_date", "Participant: Grade": "grade",
    "Date registered": "registered_date", "gender": "gender",
    "reg status": "registration_status", "In SA?": "in_sa", "SA expiry": "sa_expiry",
}
DATES = {"birth_date", "registered_date", "sa_expiry"}


def normalize(value, field):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if field in DATES:
        if isinstance(value, dt.datetime):
            return value.date().isoformat()
        if isinstance(value, dt.date):
            return value.isoformat()
        # Reject locale-ambiguous dates; never silently guess month/day.
        if isinstance(value, str):
            return dt.date.fromisoformat(value.strip()).isoformat()
        raise ValueError("Date must be an Excel date or ISO date string")
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        decimal = Decimal(str(value))
        if not decimal.is_finite():
            raise ValueError("Non-finite numeric value")
        result = format(decimal, "f").rstrip("0").rstrip(".") if "." in format(decimal, "f") else format(decimal, "f")
    else:
        result = str(value).strip()
    if len(result) > 8000:
        raise ValueError("Cell exceeds 8000 characters")
    return result


def extract(path, snapshot_date):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    cached_workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook[SHEET]
        iterator = sheet.iter_rows()
        headers = [c.value for c in next(iterator)]
        # Health columns in historical exports are ignored before reading values.
        expected = [h for h in headers if h not in {"Allergy", "Medication"}]
        if expected != list(MAPPING):
            raise ValueError("Roster headers differ from the supported non-health mapping; review source before importing")
        records, issues, warnings = [], [], []
        cached_iterator = cached_workbook[SHEET].iter_rows(min_row=2)
        for row, cached_row in zip(iterator, cached_iterator):
            if not any(c.value is not None and str(c.value).strip() for c in row):
                continue
            number = row[0].row
            record = {"source_row": number, "snapshot_date": snapshot_date, "source_values": {}}
            for header, cell, cached in zip(headers, row, cached_row):
                if header not in MAPPING:
                    continue
                raw = cell.value
                field = MAPPING[header]
                if cell.data_type == "f":
                    # Import saved snapshot results, never execute formulas or
                    # pull records from the other worksheets they reference.
                    record["source_values"].setdefault("__formulas", {})[header] = raw if isinstance(raw, str) else raw.text
                    if cached.value is None and cached.data_type not in ("str", "s", "inlineStr"):
                        issues.append({"row": number, "column": header, "reason": "Formula has no cached result; recalculate and save workbook first"})
                        continue
                    raw = cached.value
                if cell.data_type == "e" or cached.data_type == "e":
                    issues.append({"row": number, "column": header, "reason": "Excel error requires review"})
                    continue
                record["source_values"][header] = raw.isoformat() if isinstance(raw, (dt.date, dt.datetime)) else raw
                try:
                    record[field] = normalize(raw, field)
                except (ValueError, TypeError):
                    issues.append({"row": number, "column": header, "reason": "Invalid or unsupported value; source value withheld"})
            if not record.get("scout_name"):
                warnings.append({"row": number, "reason": "Scout name missing; record preserved"})
            records.append(record)
        if not 1 <= len(records) <= 10000:
            issues.append({"reason": "Expected between 1 and 10000 roster records"})
        return records, issues, warnings
    finally:
        workbook.close()
        cached_workbook.close()


def literal(value):
    # Standard PostgreSQL literal with quote escaping; workbook cells are data.
    return "'" + str(value).replace("'", "''") + "'"


def build_sql(filename, sha, snapshot_date, records):
    columns = ["source_row", "snapshot_date", *MAPPING.values(), "source_values"]
    types = {c: "date" if c in DATES or c == "snapshot_date" else "integer" if c == "source_row" else "jsonb" if c == "source_values" else "text" for c in columns}
    def clean_source(value):
        if isinstance(value, dict):
            return {key: clean_source(item) for key, item in value.items() if not re.search(r"allerg|medic|health|diagnos|treatment|condition|special.?needs", key, re.I)}
        if isinstance(value, list):
            return [clean_source(item) for item in value]
        return value
    safe_records = [{key: clean_source(value) if key == "source_values" else value for key, value in record.items() if key in columns} for record in records]
    payload = json.dumps(safe_records, ensure_ascii=False, allow_nan=False)
    return f"""-- PRIVATE ROSTER DATA. Do not commit, publish, or paste into chat.
-- First import only. Same file hash is idempotent; a different snapshot aborts.
begin;
set local standard_conforming_strings = on;
do $$ begin
  if exists (select 1 from public.roster_snapshots where source_sha256 <> {literal(sha)}) then
    raise exception 'Another snapshot exists; explicit replacement procedure required';
  end if;
end $$;
insert into public.roster_snapshots (source_sha256, source_file, source_sheet, snapshot_date, expected_rows)
values ({literal(sha)}, {literal(filename)}, {literal(SHEET)}, {literal(snapshot_date)}, {len(records)})
on conflict (source_sha256) do nothing;
insert into public.scouts (snapshot_id, {', '.join(columns)})
select s.id, {', '.join('r.' + c for c in columns)}
from public.roster_snapshots s
cross join jsonb_to_recordset({literal(payload)}::jsonb) as r({', '.join(c + ' ' + types[c] for c in columns)})
where s.source_sha256 = {literal(sha)}
on conflict (snapshot_id, source_row) do nothing;
do $$ begin
  if (select count(*) from public.scouts) <> {len(records)} then
    raise exception 'Imported record count failed reconciliation';
  end if;
end $$;
commit;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--snapshot-date", default="2026-10-21")
    parser.add_argument("--output", type=Path, default=Path(".local/import-roster.sql"))
    parser.add_argument("--report", type=Path, default=Path(".local/import-report.json"))
    args = parser.parse_args()
    dt.date.fromisoformat(args.snapshot_date)
    records, issues, warnings = extract(args.source, args.snapshot_date)
    report = {
        "sheet": SHEET, "snapshot_date": args.snapshot_date, "records": len(records),
        "issues": issues, "warnings": warnings,
        "formula_cells_using_saved_results": sum(len(r["source_values"].get("__formulas", {})) for r in records),
        "missing_by_field": {f: sum(r.get(f) is None for r in records) for f in MAPPING.values()},
        "mapping": MAPPING,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if issues:
        # Remove a stale output from a previous successful validation.
        if args.output.exists():
            args.output.unlink()
        print(f"Validation failed: {len(issues)} issues. See private report.", file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    args.output.write_text(build_sql(args.source.name, sha, args.snapshot_date, records), encoding="utf-8")
    print(f"Validated {len(records)} records; {len(warnings)} warnings. Private SQL and report written under {args.output.parent}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
