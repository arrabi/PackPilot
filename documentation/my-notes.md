# My Notes

The leader Home action chooser links directly to **My Notes** at `/notes`, below its four primary actions. More retains a second link. The page uses the Fieldbook design, a Home back link, the notice “These are your private notes. Only you can see them.”, one plain text box, a character counter, Cancel and Save notes. Saving stays in the editor and shows “Saved just now”; no record-review dialog is needed for a personal note.

Each approved leader has one personal notebook across dens and scouting years. It uses the existing `pack_leader_notes` table and revision-checked, idempotent `record_pack_community` note command, with the empty den value identifying the personal notebook. The 20,000-character limit remains enforced in the database. Existing den notes retain their IDs, contents and revisions and remain editable under **Previous den notes**; the migration does not rewrite them.

Only the author can read or edit a note. Administrators have the same boundary as other leaders for notes belonging to someone else. `read_leader_notes`, workspace projections, change history and per-field attribution all enforce the author restriction. Direct table access remains revoked, and family exports continue to exclude notes. These application permissions do not provide encryption against database operators or recovery administrators. Shared meeting planning remains separate, and the existing prohibition on medical/allergy information still applies.

Unsaved edits remain in memory through save failures and rerenders. An interrupted save retries the same request. Conflicts retain the draft and offer an explicit reload of saved notes, with confirmation before discarding edits. Cancel and sign-out confirm dirty edits; ordinary navigation uses the browser's unsaved-change warning. Signing out clears note data and drafts. The application does not put note contents in browser storage.

Validation covers database author/admin/parent boundaries, upgrade preservation, history and attribution, direct-table denial, revision conflicts, idempotency, body limits and notebook uniqueness. UI tests cover direct save, repeated edits, clearing a notebook, safe retry, conflict reload, cancel, escaping and sign-out. Chromium checks with synthetic services exercise Home → notes → save → reload, cancellation and concurrent changes at widths 320, 390, 768 and 1440 without writing staging or production records.

Release through the normal PR and Staging integration workflow. Production requires separate approval of the exact tested staging commit.
