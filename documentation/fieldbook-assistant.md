# Ask AI

The leader portal adds **Ask AI** on Today, a raised center **Ask AI** action in the fixed bottom navigation, and **Ask** in the header in staging and production deployments. The bottom action also opens the assistant on leader workspace pages such as Events without navigating away. It opens a phone conversation or desktop side panel with four reusable cards: results, choices, change review, and save confirmation. **New chat** clears the conversation and unsent draft and cancels any unsaved review; it keeps the current den/year. It is disabled while a request is running or a save outcome is uncertain. Replies and errors restore keyboard focus to the message box while the assistant is open. Scout results and scout choices show portraits from the existing authorized `read_scout_photos` data, with initials when no portrait is available. The backend supplies missing scout IDs only when the full name matches exactly one authorized roster record; namesakes and partial names are left unresolved. Family photos and portrait bytes are never included in model requests. Phone layouts follow the visual viewport (including keyboard resize, pan and zoom), wrap long content and keep Close and Send visible. Editable chat fields have a minimum computed font size of 16px to prevent iPhone focus zoom even though the app root is 14px. Both deployments use their own backend configuration and project-specific origin allowlists. Only approved leaders can use the assistant; Family Hub does not expose it.

## Setup

Configure your independent instance first using [CONFIGURATION.md](CONFIGURATION.md). In **your staging** Supabase project, open its Edge Function secrets and save:

| Secret | Value |
| --- | --- |
| `OPENAI_API_KEY` | An OpenAI API project key with permission to use the Responses API and an available billing budget. |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4.1-mini`. Choose a model supporting Responses API function calling and `max_output_tokens`. Requests explicitly use `temperature: 1.0`. |

Save keys in Supabase directly, never in chat, source, browser variables, or a frontend `.env`. Existing staging login and deployment credentials are reused. No additional MCP credential is required. OpenAI is called by the deployed Edge Function, so the cloud coding environment does not need network access or possession of the OpenAI key. Missing configuration produces a visible setup message after authentication.

Test at **your configured staging origin** with an approved staging Google account. Choose a den/year and tap **Ask AI**. Set a project budget in OpenAI; the application also limits each leader to 40 AI requests per hour, 12 tool calls and 8 model rounds per request, bounded response sizes and timeouts. Full LLM testing requires the key; synthetic tests use a deterministic provider substitute.

## Pilot scenarios

1. “Which badges are ready to hand out?” — linked results based on advancement records.
2. “Who still needs Bobcat?” — requirement/advancement lookups; missing records remain unknown.
3. “Sam returned his neckerchief yesterday.” — resolve an ambiguous scout and the actual outstanding loan, then show a return review.
4. “Mark Bobcat requirement 2 complete for [exact scout names] today.” — a canonical review with dates, selected scouts and optional parent notifications.
5. “[Names] were present at [meeting].” — a review for an existing meeting; untouched attendance remains unrecorded.
6. Ask for a correction, then change the same record in another tab before saving — a conflict requires reviewing the latest state.

The pilot supports attendance for existing meetings, registration status, requirement completion/correction, earned adventures, badge delivery, neckerchief/slider loans and loan returns. Existing screens handle roster edits, new meetings, messages, payments and catalog administration. Proposals contain up to 25 changes; larger updates should be split deliberately.

## Execution and safeguards

`fieldbook-assistant` verifies the caller with Supabase Auth and checks current approval/policy acceptance before accessing any records. It uses the caller's JWT and public project key to invoke the same schema-validated read RPCs used by MCP. There is no model-generated SQL and no service-role data access. The model only receives minimal roster identity fields plus operational records needed by its read tools. Notes and record fields are treated as data, never instructions. OpenAI requests set `store:false`; no claim is made that this disables the provider's separate abuse-monitoring retention.

The model has no save tool. Its `prepare_changes` tool asks the backend to resolve actual scouts, requirements, loans, current values and revisions. The backend generates the review and stable request IDs. `prepare_pack_assistant_change` stores the proposal under the authenticated user with a 30-minute approval expiry. Creating a new proposal cancels earlier pending proposals for that account. Saving uses only the owner-bound stored proposal ID, not client-supplied commands. Existing `record_pack_batch` applies the entire proposal atomically and preserves command history, capabilities, revisions, notification rules and retry IDs.

Changing a selection, date or notification choice requires a new review. Attendance always uses its meeting's date. A timeout preserves the proposal ID in per-account session storage: **Check save status** reads the original receipt, and **Retry same save safely** repeats the original confirmation. Saved proposals return the same result rather than repeating writes. Expired/cancelled proposals and concurrent edits require a new review. Closing the assistant preserves the in-page conversation; ordinary conversation text is not persisted to the database.

Notification toggles control the existing queue. Staging delivery remains paused, and the existing test-recipient restrictions are preserved. “Queued” never means delivered. The pilot does not dispatch mail during tests.

Proposals and hourly usage are private with no direct authenticated table access. Old entries are pruned during assistant usage after seven days (usage counters after two days); scout deletion removes any proposal mentioning that scout, and Auth-user deletion cascades to that user's assistant records. Staging data refresh truncates these private transient tables and deliberately does not copy them from production. After the verified daily production backup, `prune-assistant.py` independently expires private proposal copies older than seven days and usage buckets older than two days. It skips maintenance and pre-assistant schemas, shares the production operation lock, and never deletes scout history or touches notification queues. OpenAI credentials remain in the selected project’s Edge secrets; requests use `store:false` and reasoning stays in request memory.

## Deployment and validation

Migration `20261109010000_fieldbook_assistant.sql` adds private proposals/usage and authenticated RPCs. For a new independent instance, deploy `fieldbook-assistant` alongside the other functions after applying its migration. The inactive release workflow examples describe how a configured controller deploys the matching backend. An older rollback source without the assistant removes its optional endpoint. Production updates require the backup and approval process in [ReleaseRunbook.md](../ReleaseRunbook.md); public workflow examples remain inactive.

Tests cover identity/origin/environment rejection, missing-key setup, restricted model tools, minimal roster fields, owner isolation, approval before mutation, atomic rollback, stable retries, proposal replacement/expiry, revision conflicts, usage limits, escaped rendering and review regeneration after edits. Browser checks exercise the four cards and explicit saving at phone and desktop sizes using fictional local test data.

## Live-model regression checks

The assistant uses direct count and named-adventure status tools for common questions, avoiding repeated per-scout queries. Read tools tolerate omitted optional filters represented as null, and unfiltered count/scout lookups accept null or empty argument containers. Short answers do not require empty card fields, and a successful read can finish with ordinary text. Validation errors identify their fields; repeated reads reuse their result. Failed questions are marked as failed in subsequent conversation context, and the latest user message takes priority.

After deployment, run `python scripts/release/test-assistant.py` (staging by default), or explicitly add `--environment production` with the existing Supabase management credential. It retrieves only the selected project’s administrative key into memory and invokes `/functions/v1/fieldbook-assistant/self-test` for a minimal provider chat, a count question following a failed Bobcat question, and a Bobcat status question. The minimal probe uses the configured project key/model and a fixed public prompt with no tools. On failure, the administrator-only route includes sanitized provider HTTP status, error code/type and parameter path. Fixed fictional probes may also return a redacted technical HTTP 400 message; configured credentials and token patterns are removed. Normal leader requests never expose upstream prose, bodies, keys or prompts. This uses the configured real OpenAI model with fixed fictional scouts and adventure states. Its store cannot read real application data, prepare proposals or save changes. No new test identities or real sessions are created. The route requires that deployment’s reserved service-role key and is disabled outside recognized staging/production environments; ordinary leader tokens cannot invoke it. Output contains only fictional results, tool names, validation paths and argument/error types; prompts, argument values and real scout data are excluded. Missing staging OpenAI configuration is reported as skipped; missing production configuration fails verification. The same OpenAI key/model must be configured separately in the production Supabase project before release.


### Phone viewport regression

With the local Vite server running (`npm run dev:auth`) and Python Playwright installed, run `python scripts/test-assistant-viewport.py`. It loads the real app stylesheet (14px root), checks a 16px minimum composer font, and tests Close/Send bounds with iPhone-sized viewports, page zoom, reduced keyboard space, landscape, replies and reopening. Use `--browser webkit` when its Playwright browser build is installed. Chromium page-scale emulation exercises zoom geometry; it does not reproduce Safari's automatic input-focus zoom or replace a physical iPhone check.


### Responses API and reasoning

The assistant and fixed provider probe call `/v1/responses`. Requests use `temperature: 1`, `store: false`, a 3,000-token `max_output_tokens` cap and flat function tools. `strict: false` preserves optional read filters; server-side Zod validation and all write/review authorization remain authoritative. Model reasoning defaults remain enabled; no Chat Completions fallback or `reasoning_effort: none` setting is used.

The tool loop sends `function_call_output` items correlated by `call_id`. It requests `reasoning.encrypted_content` and carries response output items into the next stateless request, as described in the [OpenAI SDK](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts). Opaque reasoning stays in memory for this request and never enters browser history, stored proposals or diagnostic output. No provider-stored conversation or `previous_response_id` is needed.

Only completed Responses outputs can execute tools. Incomplete output, incomplete calls, missing/duplicate call IDs and refusals cannot create proposals or return partial answers. Existing request deadlines, read caching, call limits, scoped lookups, validation and explicit review/save controls remain unchanged.

A bounded compatibility retry can omit an explicitly unsupported `parallel_tool_calls` or `tool_choice` control (at most two adjustments). Tools, token limits, storage protection and reasoning continuation are mandatory. Authentication, quota, schema and other errors fail without broad retries.
