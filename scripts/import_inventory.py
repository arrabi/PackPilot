"""Validate a stock-count CSV and prepare idempotent opening-stock commands.

This prepares a plan only; it never connects to Supabase. Worksheet calculations
with an empty den column are excluded. Blank stock quantities remain unknown.
"""
import argparse
import collections
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import uuid

DEN = {"0-lion": "0-Lions", "0-lions": "0-Lions", "1-tigers": "1-Tigers", "2-wolves": "2-Wolves", "3-bear": "3-Bears", "3-bears": "3-Bears", "4-webelos": "4-Webelos", "5-aol": "5-AOL", "all": None}


def category(name):
    value = name.casefold()
    if value.startswith("core -"):
        return "required_badge"
    if re.match(r"^(elective|eletive)\s*-", value):
        return "elective_badge"
    if "neckerchief" in value:
        return "neckerchief"
    if "slider" in value:
        return "slider"
    if "book" in value:
        return "book"
    if "rank" in value:
        return "rank_insignia"
    return "other"


def prepare(path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.reader(stream))
    assert len(rows[0]) == 5 and rows[0][1:] == ["Item", "Qty.", "Last update", "Column 1"], "Unexpected inventory headers"
    snapshot = dt.date.fromisoformat(rows[0][0]).isoformat()
    entries, excluded = [], []
    for number, row in enumerate(rows[1:], 2):
        assert len(row) == 5, f"Unexpected column count at row {number}"
        raw_den, name, quantity, updated, notes = [value.strip() for value in row]
        if not raw_den:
            if any(row):
                excluded.append(number)
            continue
        assert raw_den.casefold() in DEN and name, f"Unknown den or missing item at row {number}"
        assert len(name) <= 200
        item_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"pack99:inventory:{digest}:{number}"))
        command = {"action": "define_inventory_item", "item_id": item_id, "name": name, "category": category(name), "occurred_on": snapshot,
                   "note": f"Opening stock imported from {path.name}, row {number}; sheet snapshot {snapshot}. No historical scout handouts deducted.",
                   "source_context": {"source_filename": path.name, "source_sha256": digest, "source_row": str(number), "snapshot_date": snapshot, "raw_den": raw_den, "last_update_raw": updated, "quantity_raw": quantity, "notes_raw": notes}}
        den = DEN[raw_den.casefold()]
        if den:
            command["den"] = den
        if quantity:
            assert re.fullmatch(r"[0-9]+", quantity) and int(quantity) <= 1000000, f"Invalid stock quantity at row {number}"
            command["quantity"] = int(quantity)
        if updated:
            counted = dt.datetime.strptime(updated, "%Y/%m/%d").date().isoformat()
            assert quantity and counted <= snapshot, f"Invalid count date at row {number}"
            command["counted_on"] = counted
        entries.append({"request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"pack99:inventory-opening:{item_id}")), "command": command})
    assert entries and len({e["command"]["item_id"] for e in entries}) == len(entries)
    return {"source_file": path.name, "source_sha256": digest, "snapshot_date": snapshot, "entries": entries, "excluded_worksheet_rows": excluded}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".local/inventory-import/plan.json"))
    args = parser.parse_args()
    result = prepare(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    commands = [e["command"] for e in result["entries"]]
    print(json.dumps({"stock_items": len(commands), "unknown_quantities": sum("quantity" not in c for c in commands), "zero_quantities": sum(c.get("quantity") == 0 for c in commands), "known_units": sum(c.get("quantity", 0) for c in commands), "categories": dict(collections.Counter(c["category"] for c in commands)), "excluded_worksheet_rows": len(result["excluded_worksheet_rows"])}))
