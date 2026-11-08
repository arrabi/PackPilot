# Catalog content

This candidate ships a completely synthetic CSV and generated command catalog for tests and demonstration. The 148 synthetic entries exercise pagination and manual-review behavior. They are not official adventures or requirements and must not be used to award actual advancement.

The importer retains its current schema and official-source URL validation. Obtain and review your own source material and redistribution permissions. Preserve the columns in sources/cub_scout_adventures.csv, numbered requirement format and explicit completion rules.

```bash
python scripts/import_adventures.py /path/to/private/reviewed-adventures.csv
```

Review the generated commands, then load them using an authenticated, recording-enabled leader's record_pack_operation MCP tool. Do not use a privileged service key to bypass recording permission.

Official image files are not included. badge-images.json maps adventure names/ranks to Scouting America image URLs, and rank-images.json provides rank image references. Matching does not depend on an operator's generated record IDs. The UI keeps adventure labels and uses its symbol fallback for unknown adventures. See THIRD_PARTY_NOTICES.md for image ownership and remote availability.
