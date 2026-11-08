-- Preserve all previously accepted versions; require individual acceptance of the material update.
update private.site_policy_versions set current=false where current;
insert into private.site_policy_versions(version,terms,privacy,terms_hash,privacy_hash,current)values('2026-11-02.2','# Terms of Use — operator template

This is a template for the organization operating this PackPilot instance. Review and replace it before collecting real records.

## Operator and contact

The operator is YOUR_ORGANIZATION. Contact contact@example.test for access, corrections, support and requests.

## Intended use

Authorized leaders record scouting activities, attendance, advancement and equipment. Parents access only their verified family relationships. Official scouting requirements and national registration systems remain authoritative.

## Responsibilities

Keep your sign-in secure. Enter accurate information, respect family privacy, and obtain appropriate permissions for photos and records. Do not upload medical information, credentials or unrelated sensitive records.

## Availability and changes

The operator maintains access controls, backups and versioned policies. Service can pause for maintenance. Review changes before accepting a new version.

This template is not a substitute for review of the operator''s actual practices and obligations.
','# Privacy Policy — operator template

Review and complete this template before collecting real records.

## Operator

YOUR_ORGANIZATION operates this instance. Contact contact@example.test for questions, access corrections, exports and deletion requests.

## Records and access

The service stores the roster and family contact details supplied by the operator, attendance, advancement, assignments, messages and equipment records. Approved leaders have role-based access; parents access their verified family scope. The operator must document its retention periods and review permissions regularly.

## Services

The configured providers are Supabase for database/authentication/functions, Cloudflare for website hosting and optional private backups, Google for sign-in, and Brevo for configured email delivery. Replace this list if your deployment differs. Secrets belong in provider settings, not source control.

## AI integrations

MCP access uses the caller''s authenticated permissions. If a user connects an AI client, permitted records sent to that client are subject to that client''s practices. The operator must review and explain its supported integrations.

## Backups and requests

The operator must specify backup locations, retention periods, security practices and handling of exports or deletion requests. Do not store medical notes or unrelated sensitive information.

This template describes the application model, not a completed privacy assessment for every operator.
','05287beca2d2343a5e3ce4e3d535ab2a8d954470ac47d8f7d0b4cbcbf978d6f8','e4d39e9b811bb9e218524a333c8222c216c3f4b6372aa8362f6ae5f00323e0cd',true);
update private.site_policy_versions set engagement_enabled=true where version='2026-11-02.2';
