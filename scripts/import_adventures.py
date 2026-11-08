"""Validate a user-supplied adventure CSV and prepare deterministic MCP commands.

No network calls, live writes, or interpretation of source cells as instructions.
"""
import argparse
import csv
from datetime import date
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.parse import urlparse
import uuid

FIELDS = ["Den", "Grade", "Adventure", "Type", "Requirement Count", "Completion Options", "Requirements", "Requirements URL", "Den Adventure List URL", "Notes", "Verified Date"]
RANKS = {"Lion": "lion", "Tiger": "tiger", "Wolf": "wolf", "Bear": "bear", "Webelos": "webelos", "Arrow of Light": "arrow_of_light"}
STANDARD = "Complete all listed requirements."
APPROVED = "Complete all listed requirements at an approved event."
ALTERNATIVE = "Complete all listed requirements. Alternatively, complete a Religious Emblem of the Cub Scout family’s choosing."

def official_url(value):
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "www.scouting.org" or parsed.username or parsed.password or parsed.port or not parsed.path.startswith("/"):
        raise ValueError("Expected an official HTTPS Scouting.org source URL")
    return value

def build_catalog(source: Path):
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline=""))
    if reader.fieldnames != FIELDS:
        raise ValueError("Unexpected adventure CSV columns")
    entries, seen, dates = [], set(), set()
    for row_number, row in enumerate(reader, 2):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f"Malformed row {row_number}")
        if row["Den"] not in RANKS or row["Type"] not in ("Required (Core)", "Elective") or not row["Adventure"].strip() or not row["Grade"].strip():
            raise ValueError(f"Invalid identity/type at row {row_number}")
        key = (RANKS[row["Den"]], row["Adventure"].casefold())
        if key in seen:
            raise ValueError(f"Duplicate den/adventure at row {row_number}")
        seen.add(key)
        verified = date.fromisoformat(row["Verified Date"]).isoformat()
        if verified != row["Verified Date"]:
            raise ValueError(f"Non-ISO verification date at row {row_number}")
        dates.add(verified)
        official_url(row["Den Adventure List URL"])
        source_url = official_url(row["Requirements URL"])
        text = row["Requirements"]
        starts = list(re.finditer(r"(?m)^(\d+)\.\s+", text))
        count = int(row["Requirement Count"])
        if not 1 <= count <= 100 or len(starts) != count or [int(m[1]) for m in starts] != list(range(1, count + 1)) or text[:starts[0].start()].strip():
            raise ValueError(f"Requirement numbering/count mismatch at row {row_number}")
        requirements = []
        for index, match in enumerate(starts):
            end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
            description = text[match.end():end].strip()
            if not 1 <= len(description) <= 2000:
                raise ValueError(f"Invalid requirement length at row {row_number}")
            requirements.append({"code": match[1], "description": description, "source_url": source_url})
        options = row["Completion Options"]
        if options not in (STANDARD, APPROVED, ALTERNATIVE):
            raise ValueError(f"Unrecognized completion options at row {row_number}; review before importing")
        # Retain the listed path, but never infer readiness for alternatives or
        # external conditions. A leader can explicitly record earning an award.
        review = options != STANDARD or bool(row["Notes"].strip())
        version = f"csv-{verified}-{digest[:12]}"  # Snapshot ID, not an asserted official program edition.
        adventure_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"pack99:{version}:{key[0]}:{key[1]}"))
        command = {
            "action": "define_adventure", "adventure_id": adventure_id,
            "name": row["Adventure"], "rank": key[0], "program_version": version,
            "source_url": source_url, "source_verified_on": verified,
            "requirements": requirements,
            "completion_groups": [{"minimum": count, "codes": [r["code"] for r in requirements]}],
            "readiness_mode": "leader_review" if review else "automatic",
            "catalog_context": {
                "grade": row["Grade"], "adventure_type": row["Type"],
                "completion_options": options, "notes": row["Notes"],
                "den_list_url": row["Den Adventure List URL"],
                "source_filename": source.name, "source_sha256": digest, "source_row": row_number,
                "verification_basis": "user_supplied_csv",
            },
        }
        entry = {"request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"pack99:define:{adventure_id}")), "command": command}
        if len(json.dumps(command, ensure_ascii=False).encode()) > 32768:
            raise ValueError(f"Definition too large at row {row_number}")
        entries.append(entry)
    if not entries:
        raise ValueError("Empty adventure CSV")
    counts = {den: sum(e["command"]["rank"] == rank for e in entries) for den, rank in RANKS.items()}
    return {
        "source_filename": source.name, "source_sha256": digest,
        "verification_basis": "User-supplied CSV; referenced web pages have not been independently fetched.",
        "supplied_verification_dates": sorted(dates), "adventure_count": len(entries),
        "requirement_count": sum(len(e["command"]["requirements"]) for e in entries),
        "counts_by_den": counts,
        "leader_review_count": sum(e["command"]["readiness_mode"] == "leader_review" for e in entries),
        "entries": entries,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("catalog/adventures.json"))
    args = parser.parse_args()
    catalog = build_catalog(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in catalog.items() if k != "entries"}, indent=2))

if __name__ == "__main__":
    main()
