# PackPilot release and recovery notes

This public starter has validation CI only. The source application's provider architecture and permission model are unchanged. The inactive workflow examples are reference material; they are not a completed fresh-install production controller. Never supply another instance's baseline, receipts or operation IDs.

## First empty installation

Follow documentation/SETUP.md against new projects that you own. Configure placeholders before applying the first migration. Verify Google login, policy acceptance, leader/family isolation, public MCP discovery and denied unauthenticated access before importing real records. Keep delivery paused and restrict staging to the configured test inbox.

## Updates with real records

Use a branch and passing checks; deploy/test the exact source on isolated staging first. Before an approved production update: pause notification generation/delivery, drain invocations, enable the backend write barrier, capture/read back a private recovery point, then apply only reviewed compatible migrations, matching functions and website. Verify health and published version before reopening writes/delivery.

Do not reverse migrations automatically. A failed operation must keep a durable record and recovery pins; inspect partial state before retrying. Application rollback must keep the newer schema and compatible guarded backend. Data restoration is separate and needs an explicit recovery-point/data-loss decision and notification-history reconciliation.

## Backups

Use scripts/release/backup.py with your own managed Supabase/R2 settings for capture, readback, freshness and bounded retention. Run scripts/release/rehearse-backup.py against a selected private backup in isolated services. Establish and test your own schedule, failure alerts and independent recovery access before using real family records. The future production release controller must preserve these gates rather than skip them.
