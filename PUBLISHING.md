# Review before public publishing

1. Run npm ci, npm run check and the Python tests from a clean checkout. Check CI after the first push.
2. Review the full file list and scan for credentials, personal data, original deployment identifiers and unintended binary assets. Synthetic fixtures are not a substitute for manual review.
3. Confirm ownership/attribution for the original code and keep THIRD_PARTY_NOTICES.md. Standalone official image files and copied requirement descriptions are excluded; image manifests contain official remote URLs only. Sample UI screenshots retain the supplied instance's branding and displayed artwork, as described in THIRD_PARTY_NOTICES.md.
4. Review the manual setup and inactive deployment examples. A real fresh provider installation has not been performed for this candidate. The original instance-specific adoption/bootstrap scripts and acceptance receipts are not included.
5. Review before the first push. A push to a public repository immediately publishes that branch, even before merging. Do not push another repository's branches, tags, logs or artifacts.

This copy starts from the destination repository's initial MIT license commit. It contains no history from the private source repository. Preserve that license, use a public commit identity, and publish the reviewed source on a branch:

```bash
git status --short
git add .
git commit -m "Initial PackPilot source release"
git push -u origin HEAD
```

Open a pull request against main and review its validation results before merging. Keep configured instance files and real data private. Exclude node_modules, .local, local environment files, build output and scans from the source commit.
