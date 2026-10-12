# Job Application Tracker

A Google Apps Script that reads your Gmail (read-only), uses an LLM to understand job-application
emails — including replies with unusual wording and emails you sent — and keeps a Google Sheet with
**one row per application**, a full **event history**, a **review queue** for anything uncertain, a
**feedback store** of your corrections, and a formula-driven **dashboard**. No server or database:
everything runs in Apps Script and lives in the spreadsheet. It never sends email or changes your mailbox.

Built on [adamrangwala/Job-Application-Tracker](https://github.com/adamrangwala/Job-Application-Tracker) (MIT).
A v1 sheet from that project is migrated without losing data (see [Migrating from v1](#migrating-from-v1)).

> **Status:** the code is covered by local tests with simulated Gmail, Sheets and model responses
> (`npm test`). It has **not** been run against a live Gmail account, a live Google Sheet or the live
> LLM API by the author of these changes. Follow [First run](#first-run) before relying on it.

---

## How it works

```
Discovery (records message IDs only)          Processing (bounded by the 6-minute run limit)
  Gmail change history  -- every new message,      Work Queue (durable: attempts, retry time, last error)
     sent or received, any wording                   -> triage   LLM screens subject/sender/snippet in batches
  Backfill search over a date range,                             (skipped for threads already linked to an application)
     resumable page by page                          -> classify LLM reads the message + earlier thread messages
  Known-thread monitoring -- re-checks                           and returns a strict JSON interpretation
     threads of open applications for replies       -> validate  schema, evidence, dates/time zones, sender (code)
                                                    -> match     thread, job URL, verified model match, company+title (code)
                                                    -> derive    status from the application's whole event history (code)
                                                    -> write     only new rows and changed cells, then mark the task done
```

The **LLM decides what a message means**. **Code decides what is allowed to change**: identifiers,
deduplication, validation, matching, status rules, retries and persistence. Keywords are not used to
classify anything; the only filter before the LLM is Gmail's own categories (promotions/social/forums,
spam, trash), configurable in `config.gs`.

| File | Purpose |
|---|---|
| `config.gs` | Every setting (model, time zone, backfill start, batch sizes, retries, …) |
| `main.gs` | Menu, scheduled trigger handler, diagnostics, `onEdit` for status overrides |
| `syncUtils.gs` | Discovery, Work Queue, triage, classification, persistence, review processing |
| `llmProvider.gs` | Provider interface + Groq and Anthropic implementations (UrlFetchApp), error categories, pacing, cost estimate |
| `semanticUtils.gs` | Prompts, JSON schemas, strict output validation, few-shot example retrieval |
| `dateUtils.gs` | Date/time-zone checks and conversion |
| `statusUtils.gs` | Status derivation from event history; safety checks |
| `matchUtils.gs` | Application identity (candidates for the model, final match decision) |
| `extractionUtils.gs` | Structural parsing: sender, HTML, quoted history, normalization, hashing |
| `spreadsheetUtils.gs` | Schema, non-destructive setup/migration, batched writes, formatting |
| `dashboardUtils.gs` | Dashboard tab (formulas + 2 charts) |
| `appsscript.json` | Manifest: scopes, Gmail advanced service |
| `tests/` | Node tests with fakes and a scripted model; `tests/eval/` evaluation set and runner |

### Tabs

| Tab | One row per | You edit |
|---|---|---|
| **Applications** | distinct application (`APP-…` ID, never a row number) | green-header columns |
| **Email Events** | interpreted message (append-only history; reclassification supersedes, never deletes) | `Corrected Event Type`, `Corrected Application ID` |
| **Review Queue** | uncertain case | `Review Status` and `Corrected …` columns |
| **Dashboard** | live formulas | nothing |
| Work Queue *(system)* | discovered message: stage, state, attempts, next retry, last error | nothing |
| Feedback Examples *(system)* | your correction | `Use As Example` (Yes/No); delete rows freely |
| Sync Log *(system)* | run: counts, model calls, tokens, est. cost, queue depth | nothing |

**Applications** stores: Application ID, Company, Job Title, normalized company/title, Application Date,
Current Status, Auto Status, Status Source, Job URL, Location, Work Arrangement, Job Source, Recruiter
Name/Email, Last Activity Date, Last Relevant Gmail Thread URL, Interview Date + Details, Assessment
Deadline + Details, Next Action, Follow-up Date, Resume Version, Manual Status Override, Review State,
Confidence, Notes, Created/Updated At. Unknown values stay blank — nothing is invented, and Resume Version
is never filled automatically.

**How fields are updated.** Editable (green) columns are only filled when blank, so your edits are kept.
Exceptions: Interview Date is replaced by a *confirmed* time from a newer email or a reschedule, and cleared
by a confirmed cancellation; proposed times go to Interview Details only. Assessment Deadline is replaced by a
later deadline or when the stored one is already past. Dates are stored as instants and shown in the sheet's
time zone; the Details columns keep the ISO time with offset, the zone and the original text, e.g.
`2026-03-13T11:00:00+05:30 [+05:30] from "Friday 13 March, 11:00 (UTC+05:30)"`.

### Event types and statuses

The model returns one of: APPLICATION_SUBMITTED, APPLICATION_CONFIRMATION, ASSESSMENT_INVITATION,
ASSESSMENT_REMINDER, INTERVIEW_INVITATION, INTERVIEW_SCHEDULED, INTERVIEW_UPDATED, INTERVIEW_CANCELLED,
INTERVIEW_COMPLETED, OFFER_RECEIVED, REJECTION_RECEIVED, WITHDRAWAL_REQUESTED, APPLICATION_WITHDRAWN,
RECRUITER_OUTREACH, JOB_ADVERTISEMENT, DOCUMENT_REQUEST, OTHER_RELEVANT, UNRELATED, NEEDS_REVIEW — plus a
qualifier: actual, proposed, hypothetical, quoted_history, cancelled or unclear.

Statuses: `Applied`, `Assessment`, `Interview`, `Offer`, `Rejected`, `Withdrawn`. Only *actual* events change
status. Submitted/confirmation → Applied; assessments → Assessment; interview invitation/scheduled/updated/
completed → Interview; offer → Offer; rejection → Rejected; withdrawn, or a withdrawal **you sent** → Withdrawn.
Cancellations, document requests, outreach and other messages are kept in history without changing status.
"No reply for N days" is a dashboard label, never a status.

**Status is re-derived from the application's whole event history in chronological order**, so it does not
matter in which order emails are processed:
- a later acknowledgement never downgrades Interview/Offer;
- quoted old text is not an event (the model is told so, and high-impact events need evidence from the new text);
- a newer rejection/withdrawal closes the application;
- a rejection after an offer, or progress after a rejection/withdrawal, is **kept in history and sent to
  review** (kind `conflict`) instead of being applied; approving it applies it;
- **Manual Status Override** always wins: `Current Status` = override if set, else `Auto Status`. Editing it
  takes effect immediately; syncs keep updating `Auto Status` underneath; clearing it restores the automatic value.

### Matching (`matchUtils.gs`)

Code chooses up to 6 candidate applications to show the model (same thread, same recruiter, company name
appears in the email), and code makes the decision, in this order:
1. Gmail thread already linked to exactly one application → that one (unless the email clearly names a
   different role, or the model confidently names a different candidate → review).
2. Same job URL (host + path).
3. The model's proposed candidate — only if its company and role agree with what the email says.
   Offers, rejections and withdrawals must also state the role here.
4. Same normalized company **and** role.
5. Same company but no role, or a similar role (possible rename) → review.
6. Company and role known, nothing matches, and the event starts an application → new application.
7. Anything else → review.

Company alone never merges applications. One application can collect any number of threads.

### Safety checks (all in code)

A classification is sent to the Review Queue instead of being applied when any of these hold:
- output fails strict schema validation (it is then retried, never applied) or names an application ID that
  was not offered;
- the model says NEEDS_REVIEW, reports low confidence, contradictions, or "not relevant" with a status event;
- **offer, rejection, withdrawal**: confidence is not high; no quoted evidence appears verbatim in the *new* part
  of the message; it came from a forward; an employer outcome in mail you sent; a withdrawal request you did
  not send; or the sender is not plausibly speaking for the employer (not you, not a hiring platform, not the
  application's thread or recruiter domain, and the domain does not contain the company name);
- the match decision says review;
- a date check fails (the event is applied, the date is not; review kind `date`).

Model output is treated as untrusted: only enum values and length-limited strings are stored, only plain
`http(s)` links are kept, and every text written to the sheet is escaped so it cannot become a formula.

### Dates and time zones (`dateUtils.gs`)

The model reports each date's original text, the wall-clock date/time and the zone the email means (IANA name
or UTC offset) without converting. Code then:
- converts using that zone, including daylight-saving (a time that does not exist → review);
- checks **relative dates** ("tomorrow", "this Friday", "next Monday") against the email's own send time in that
  zone — not the time the backfill runs; "next Monday" accepts either of its two common meanings;
- sends **all-numeric dates** like 03/04/2026 to review unless you set `NUMERIC_DATE_ORDER` ('DMY' or 'MDY');
- sends ambiguous **zone abbreviations** (IST, CST, BST, AST, GST, SST, ECT, MST, CDT, PST) to review unless the
  model states what the abbreviation means from context;
- flags dates with no year that land far from the email date, impossible dates and unknown zone names;
- uses `USER_TIMEZONE` only when an email gives a time with no zone (recorded as "assumed your time zone").
Date-only values stay date-only (`2026-03-20`).

### Feedback: how it learns from corrections

The model is **not trained or fine-tuned**. Corrections are stored and **retrieved as examples** in later prompts:
- Approving a review with changed values, ignoring a classification/match review (= "not relevant"), or typing
  `Corrected Event Type` / `Corrected Application ID` into Email Events records a Feedback Examples row: original
  prediction, corrected value, a short excerpt (subject, sender, evidence quote — not the body), model, prompt
  version, outcome, and `Use As Example = Yes`.
- Manual status overrides are recorded too (`Use As Example = No`: they carry no email text).
- For each new message, up to `REVIEW.FEW_SHOT_EXAMPLES` (3) examples with `Use As Example = Yes` are chosen by
  word overlap with the subject/text plus a bonus for the same sender domain, and included in the prompt as
  `<reviewed_examples>`. Unreviewed predictions are never used as examples.
- Inspect/export: open the Feedback Examples tab (File → Download → CSV to export). Stop using one: set
  `Use As Example` to No or delete the row. Delete all: Job Tracker → Data → Delete all feedback examples.
- To check whether corrections help, export the tab as JSON-like rows and run the live evaluation with and
  without `--examples` (see [Evaluation](#evaluation)).

---

## LLM provider

Two providers are built in; choose with `LLM.PROVIDER` in `config.gs`. Each has a settings profile in
`LLM.PROFILES` (models, effort, token limits, batch sizes, prompt trimming).

### Groq (default — has a free tier)
- Endpoint `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible), called with `UrlFetchApp`.
- Models: classification `openai/gpt-oss-120b`, triage `openai/gpt-oss-20b` — both support Groq's **strict**
  JSON-schema structured output (`response_format: {type: "json_schema", json_schema: {strict: true}}`), so replies
  always match the schema. `reasoning_effort: "low"`, `include_reasoning: false` (reasoning text is not returned or stored).
- Key: create one at <https://console.groq.com/keys> (starts with `gsk_`), then **Job Tracker → Setup → Set LLM API
  key**. Stored in Script Properties as `GROQ_API_KEY`.
- **Free-tier limits** (Groq's published table at the time of writing — check
  <https://console.groq.com/docs/rate-limits> for your account): for each of the two models, 30 requests/minute,
  8,000 tokens/minute, 1,000 requests/day, 200,000 tokens/day. Using a different model for triage gives it its own allowance.
- What the code does about it: requests are sent one at a time; prompts are trimmed (4,000 chars of new text, 1,000 of
  quoted text, 2 earlier thread messages of 700 chars); triage batches 10 messages; after each response the
  `x-ratelimit-remaining-tokens` / `x-ratelimit-reset-tokens` headers are read and, when the minute's tokens are nearly
  used, the run waits for the window to reset (at most 30 s); a 429 with a short `retry-after` is waited out once, a
  longer one goes back to the Work Queue with backoff.
- **What that means in practice:** a classification uses roughly 4–7k tokens, so about one per minute and
  ~30–50 per day fit the 120b model's daily token budget; triage (20b) screens roughly 400–600 messages a day. That is
  plenty for day-to-day mail, but a large **backfill takes many days**. Nothing is lost while waiting — the queue
  resumes — but start with a short `BACKFILL_START` (a few weeks), narrow `BACKFILL_QUERY` if needed, or upgrade the
  Groq plan. Cost estimates show $0 for the free tier (`LLM.PRICES`); fill in prices if you pay.
- Quality: the open-weight `gpt-oss` models have not been measured on this task. Run the live evaluation
  (`GROQ_API_KEY=... npm run eval:live`) and the dry run before trusting the results; the code-side safety checks apply
  regardless of model.

### Anthropic (paid)
Set `LLM.PROVIDER: 'anthropic'`. Messages API with `output_config.format` (JSON schema) and
`output_config.effort: "low"`; default model `claude-opus-5-5` for both steps; server-side refusal fallback
(`fallbacks: "default"`, beta header `server-side-fallback-2026-07-01`; `USE_FALLBACKS: false` to disable). Key from
<https://platform.claude.com> → **Set LLM API key** (stored as `ANTHROPIC_API_KEY`). Up to 4 requests in parallel and
larger prompts. Rough cost at $4 / $20 per million input/output tokens: triage of 25 messages ≈ $0.03, a
classification ≈ $0.02–0.05; a 6-month backfill with ~5,000 candidate and ~400 relevant messages ≈ $15–30. A cheaper
triage model (e.g. `claude-haiku-5-5`) cuts that; measure with the evaluation first.

### Common behaviour
Keys are read from Script Properties and never logged or shown. Errors are categorised: `rate_limit` (429) and
`transient` (5xx, network/timeout) are retried with backoff; `invalid_output` (bad JSON, schema failure, output limit
reached) is retried; refusals and permanent errors (e.g. a request larger than the model accepts) go to the dead-letter
state; `config` errors (bad key/model/request, 400/401/403/404) stop the run without using up attempts.
`UrlFetchApp` has no configurable timeout; a hung request is ended by Apps Script and counted as transient. Every
classification records model and prompt version (`classify-v1`). Results are cached per message by a hash of the
message, its thread context, the prompt version and the model: unchanged messages are never sent twice; a changed
message (or **Reclassify**) supersedes the old event. Switching provider or model does not reclassify old messages.
To add another provider, add an entry to `LLM_PROVIDERS` in `llmProvider.gs` (same `run()` contract) and a profile.

**What is sent to the provider:** for triage — sender, recipients, subject, Gmail's snippet (≤300 chars) and
direction for each message in the batch; for classification — sender, recipients, subject, send time, the new text of
the message, quoted history, earlier messages of the thread (sizes per profile above), up to 6 candidate applications
(company, title, status, last activity, job URL) and up to 3 feedback excerpts. Attachments are never read. Check the
provider's data-use terms for your account (Groq: <https://console.groq.com/docs/your-data>).

The Sync Log and dry run report model calls, tokens and estimated cost for every run.

---

## First run

### 1. Get the code
```bash
git clone https://github.com/<you>/Job-Application-Tracker.git
cd Job-Application-Tracker
npm test          # optional: local tests + guard evaluation (Node 18+, no dependencies)
```
Edit `config.gs`: set `USER_TIMEZONE` (e.g. `Asia/Kolkata`), `DISCOVERY.BACKFILL_START`, and optionally
`NUMERIC_DATE_ORDER`.

### 2. Spreadsheet and Apps Script project
The script must be **bound** to the sheet (it uses `spreadsheets.currentonly`).
1. Create a Google Sheet, or open your v1 tracker (**File → Make a copy** first, as an extra backup).
2. **Extensions → Apps Script.** Delete v1 files if present (`main.gs`, `extractionUtils.gs`, `statusUtils.gs`,
   `spreadsheetUtils.gs`, `applicationUtils.gs`/`applicationInsights.gs`, `jobTitleVisualization.gs`).
3. Add one script file per `.gs` file here, same names, and paste the contents: `config`, `main`, `syncUtils`,
   `llmProvider`, `semanticUtils`, `dateUtils`, `statusUtils`, `matchUtils`, `extractionUtils`,
   `spreadsheetUtils`, `dashboardUtils`.
4. **Project Settings → tick "Show appsscript.json"**, then replace `appsscript.json` with this repo's version
   (declares scopes and enables the Gmail advanced service; check **Services** lists "Gmail API").
5. **Project Settings → Time zone:** your zone. Also **File → Settings → Time zone** in the sheet. Make both match
   `USER_TIMEZONE` (Diagnostics warns otherwise).
6. Save and reload the sheet; a **Job Tracker** menu appears.

*clasp alternative:* `npm i -g @google/clasp`, `clasp login`, `clasp clone <scriptId>` into an empty folder, copy
the `.gs` files, `appsscript.json` and `.claspignore` in, `clasp push` (`.claspignore` keeps tests out).

### 3. Authorize and add your API key
1. **Job Tracker → Setup → Setup / migrate workbook.** Authorize (unverified personal script: Advanced → Go to …).
   Permissions:

   | Scope | Why |
   |---|---|
   | `gmail.readonly` | Read messages, threads and the change history. Cannot send, delete or label. |
   | `spreadsheets.currentonly` | Only the spreadsheet the script is bound to. |
   | `script.external_request` | Call the LLM API (Groq or Anthropic). |
   | `script.scriptapp` | Install/remove the scheduled trigger. |
   | `script.container.ui` | Menu and dialogs. |

   No send-mail or Drive scope is requested.
2. Create a free Groq API key at <https://console.groq.com/keys> (or an Anthropic key, after setting
   `LLM.PROVIDER: 'anthropic'`), then **Job Tracker → Setup → Set LLM API key** and paste it. It is stored in Script
   Properties (`GROQ_API_KEY` / `ANTHROPIC_API_KEY`); type `DELETE` there to remove it.
3. **Setup → Test LLM connection** — shows model, latency and the cost of the test call.
4. **Setup → Diagnostics and configuration check** — fix every `FAIL` and read `WARN` lines.

### 4. Dry run a small sample
**Job Tracker → Dry run on a sample (no writes)**: choose how many messages (default 20) and optionally a date
range (`2026-03-01..2026-03-31`). It runs the real pipeline — Gmail reads, triage, classification, matching,
validation — in memory and shows one line per message plus model calls, tokens and estimated cost:
```
applied: APPLICATION_CONFIRMATION | Acme Robotics / Software Engineer Intern -> APP-… [Applied] | "Thank you for applying…"
review: REJECTION_RECEIVED | Wayne Enterprises / Software Engineer Intern | "Re: Your application"
not relevant (triage): newsletter | "This month at …"
```
Nothing is written to the sheet, no checkpoint changes. It does make model calls (free on Groq's free tier, but they
count against its daily limits). It samples messages the tracker has not processed yet. On Groq's free tier keep
samples small (10–20).

### 5. Inspect, then backfill
1. Set `BACKFILL_START` to a recent month first (a few weeks on Groq's free tier). **Backfill → Start / resume backfill.** This also installs the
   scheduled sync, which continues the backfill every `SYNC_EVERY_MINUTES` (30) until it is complete.
2. Check **Applications**, **Email Events** (event, qualifier, evidence, reason, model, state), **Review Queue**
   and **Sync Log**. **Queue health** shows waiting work, the oldest waiting message and backfill progress.
3. Correct what is wrong (below), then widen the range: change `BACKFILL_START`, **Backfill → Restart backfill**,
   **Start / resume backfill** (already-processed messages are skipped at no model cost).

### 6. Ongoing
The scheduled sync reads Gmail's change history (new mail, sent or received), re-checks a rotating set of known
threads, continues any backfill/rescan, retries due work and classifies. **Sync now** does the same on demand.

---

## Daily use

**Review Queue.** Each row has a Kind (`classification`, `match`, `date`, `conflict`, `processing-failed`), the
proposal, evidence, uncertainty and reason. For each `Pending` row:
- accept: optionally fill `Corrected Company`, `Corrected Job Title`, `Corrected Event Type` (required when the
  proposal is NEEDS_REVIEW), `Corrected Application ID` (an `APP-…` ID, or `NEW` to force a new application),
  `Corrected Date` (a date/time for interview or assessment), then set `Review Status = Approved`;
- dismiss: `Review Status = Ignored`;
- then **Job Tracker → Process approved reviews and corrections**. Processed rows become `Done`; rows that cannot
  be applied stay `Approved` and are listed. Running it again never applies anything twice.

**Other corrections.** Edit Applications cells directly (kept by syncs); set `Manual Status Override`; type a
`Corrected Event Type` / `Corrected Application ID` in Email Events and run *Process approved reviews and
corrections* (moves the event to the right application and recomputes both); select rows in Email Events / Review
Queue / Work Queue and **Reclassify selected message(s)** to re-run the model on them (ignores the cache);
**Reconcile application statuses** re-derives every status from its events without model calls.

**Follow-ups.** `Next Action` (suggested by the model when blank) and `Follow-up Date` are yours to edit. Rows are
highlighted: overdue follow-up red, follow-up due soon yellow, interview within 7 days blue, assessment due within
3 days orange, pending review pink, offer green, closed grey. Reminders stay in the spreadsheet; nothing is emailed.

**Dashboard** (built by Setup; live formulas over the tabs; columns found by header name): total/active
applications, offers, rejections, upcoming interviews, pending assessments, pending reviews, overdue and soon-due
follow-ups, "no reply for N days", work-queue waiting/failed counts, last sync time/result, counts by status
(chart), applications per month (chart), and lists of upcoming interviews, assessment deadlines, overdue and
upcoming follow-ups, quiet applications and the 10 latest events. After changing dashboard-related config, run Setup.

---

## Operations

### Retries and failures
Each Work Queue task stores attempts, last attempt, next attempt time, error category and summary.
Backoff: 5 min, 30 min, 2 h, 8 h, 24 h (`QUEUE.BACKOFF_MINUTES`); after `QUEUE.MAX_ATTEMPTS` (5), or at once for
permanent errors (message deleted) and refusals, the task becomes `dead`, `Needs Manual = Yes`, and a
`processing-failed` review row appears: **Approve** re-queues it with a fresh attempt count, **Ignore** drops it.
**Retry waiting work now** makes all waiting retries eligible and runs a sync. A task is marked done only after its
results are written, so interrupted runs resume where they stopped and a partially written run never duplicates
applications or events (write order: Applications → Review Queue → Email Events → Feedback → Work Queue).
A run reports `complete` only when no work is waiting; otherwise `partial`.

### Discovery coverage — what is and is not guaranteed
- **Change history** covers every message added to the mailbox after tracking starts (sent and received), except
  labels in `SKIP_LABELS` (spam, trash, drafts, chats). Gmail keeps history for a limited time (typically about a
  week); after a long pause the tracker falls back to a search from 2 days before the last fully successful sync
  (`FALLBACK_OVERLAP_DAYS`) and notes it in the Sync Log.
- **Backfill/rescan** cover what `BACKFILL_QUERY` matches in the date range. The default excludes Gmail's
  Promotions, Social and Forums categories; if your hiring mail lands there, remove those terms (more triage cost).
- **Thread monitoring** re-checks `THREADS_PER_RUN` (40) threads per run, rotating through threads of open
  applications and of applications closed within `WATCH_CLOSED_DAYS` (30).
- **Rescan a date range** lists a period again and queues any message not seen before.
- Messages triaged as not relevant are not classified. Triage is told to keep anything uncertain; you can
  re-check one with **Reclassify**.

### Logs
**Sync Log** (one row per run): result, discovered, triaged, classified, written, skipped, retried, failed, dead,
sent to review, model calls, tokens, estimated cost, average latency, queue depth, oldest waiting message, notes.
**Apps Script → Executions** has full logs (IDs, counts and error summaries — no message bodies, no key).
`LOG_LEVEL: 'DEBUG'` adds detail. Trigger runs that throw also produce Google's failure email.

### Quotas (Google's published limits; check them for your account type)
Per <https://developers.google.com/apps-script/guides/services/quotas>: 6 minutes per execution; **total trigger
runtime 90 min/day on consumer (gmail.com) accounts, 6 h/day on Google Workspace**; URL Fetch calls 20,000/day
(consumer) / 100,000/day (Workspace); 20 triggers per user per script; Script Properties 9 KB per value.

What that means here: each run stops starting work after 4.5 minutes. Classification sends
`LLM.PARALLEL_REQUESTS` (4) requests at once; a run classifies up to `QUEUE.CLASSIFY_PER_RUN` (40) messages, fewer
when the model is slow. On a consumer account, ~20 full-length runs fit in the daily trigger budget, so a large
backfill (thousands of relevant messages) takes days; when the budget is used up, triggers fail until the next day
and work resumes from the queue — nothing is lost. Every run reads the data tabs fully, which is fine for
thousands of rows; tens of thousands of Work Queue rows will slow runs (archive old `done` rows by copying the tab
and deleting them if that happens). The LLM provider's own rate limits also apply (429s are retried).

### Backup, restore, rollback
- Before big changes: **File → Make a copy.** Restore: **File → Version history → See version history**.
- Setup never clears or deletes a data tab: missing columns are added after copying the tab to
  `Backup <tab> <timestamp>`; a tab with unknown headers stops setup unchanged.
- **Data → Clear tracker data** copies Applications, Email Events, Review Queue, Work Queue and Sync Log to backup tabs
  and then empties them (requires typing `CLEAR`); feedback is kept.
- Reset sync progress only: Project Settings → Script Properties → delete `TRACKER_STATE_V3`.
- Code rollback: restore the previous `.gs` files (git history); v1 data stays in its `Legacy Applications …` tab.

### Migrating from v1
Run Setup on the v1 sheet. It renames the v1 `Applications` tab to `Legacy Applications <timestamp>` (contents
untouched), creates the new tabs, and imports each v1 row (Company, Job Title, dates, status mapped:
`Interview Request`→Interview, `Offer Received`→Offer, `Status Update`→Applied; "Unlisted" placeholders become
blank; exact company+title duplicates merged). Each imported application gets a `migrated` event carrying its v1
status and date, so its status is kept until newer evidence arrives, and its v1 Gmail thread is monitored for
replies. v1's daily `scanEmails` trigger is removed. Running Setup again imports nothing. v1's rejection-draft and
feedback-form features were removed (drafts need a Gmail scope that can also send).

### Updating the code
Pull, run `npm test`, paste changed files (or `clasp push`), run **Setup** once (adds new columns), then
**Diagnostics**. A new `PROMPT_VERSION` does not reclassify old messages automatically; use **Reclassify** for those
you want refreshed.

### Disabling and revoking
1. **Schedule → Remove all tracker triggers** (removes only this tracker's triggers).
2. **Setup → Set LLM API key** → `DELETE`; revoke the key in the Groq (or Anthropic) console.
3. Revoke Google access at <https://myaccount.google.com/permissions>. Optionally remove the script project.

---

## Testing and evaluation

```bash
npm test             # unit + end-to-end tests, then the guard evaluation
GROQ_API_KEY=gsk_... npm run eval:live        # live evaluation on Groq (free tier: paced, takes a while)
ANTHROPIC_API_KEY=sk-ant-... npm run eval:live # or on Anthropic (costs money; prints the estimate)
```
- `tests/logic.test.js` — pure functions: quoted-text separation, malformed input, evidence matching, dates
  (explicit zones, offsets, midnight crossing, date-only, ambiguous numeric dates, relative dates vs send time,
  ambiguous abbreviations, DST before/after/gap, missing year), schema validation, triage validation, status
  derivation (chronology, no downgrade, qualifiers, cancellation ≠ rejection, user withdrawal, conflicts),
  safety checks, sender plausibility, matching (same-company roles, thread, URL, verified model match, renamed
  roles), candidates, provider request shape and every error category, schema compatibility, prompt delimiting,
  example retrieval.
- `tests/groq.test.js` — Groq request shape (strict schema, bearer key, reasoning settings), every error category,
  short-429 retry and token-window pacing, key validation, prompt trimming, and a full pipeline run on the Groq profile.
- `tests/sync.test.js` — full runs over fake Gmail/Sheets/Properties/Lock/UrlFetchApp with a scripted model:
  multi-thread applications, unusual wording, replies without keywords, sent withdrawal, cancellation, known-thread
  monitoring, change history + expired-history fallback, repeated sync with no new calls, content change, quoted
  rejection and ambiguous-date guards, prompt injection (incl. a fooled model naming a real application),
  rate limits/malformed JSON/backoff/dead-letter/re-queue, bad key, missing key, 230-message paginated backfill
  with an interruption, partial persistence failure, lock contention, dry run with zero writes, manual override,
  review approval/correction with crash-and-retry, feedback retrieval in later prompts, event corrections,
  conflicting chronology, empty mailbox, reconcile/reclassify, v1 migration, column migration with backup,
  dashboard header references, triggers and confirmed data deletion.
- `tests/eval/` — 26 labelled synthetic cases. **Guard mode** (no key, part of `npm test`) feeds correct answers
  and 10 deliberately wrong high-impact answers through the real validation/matching/guard code; threshold: zero
  dangerous results applied automatically. **Live mode** sends each case through the real request code (`curl`
  shim) and reports relevance, event-type, company, title and match accuracy, review rate, dangerous results
  applied automatically, status changes that differ from the label, calls, tokens, cost and latency; it exits 1
  if a dangerous result or a wrong match would be applied automatically. Compare runs with
  `--examples feedback.json` (an array of Feedback Examples rows) to see whether corrections change results.

The fakes reproduce only the calls this code makes. They do not prove live Gmail/Sheets/LLM behaviour,
formula evaluation, formatting or quotas — see [First run](#first-run).

## Known limitations

- Not yet verified against live Google services or the live model (see the status note at the top).
- Model quality is unmeasured until you run `npm run eval:live`; the guard evaluation only measures the code.
- Groq's free tier allows roughly 30–50 classifications a day; large backfills take many days (see *LLM provider*).
- Discovery limits are described under *Discovery coverage*. Triage false negatives are not re-checked
  automatically.
- Relative-date checks cover today/tomorrow/weekday forms; other relative phrases ("end of next week") are
  accepted as the model resolved them, with the original text kept.
- Throughput is bounded by Apps Script quotas (*Quotas*). Very large mailboxes need days for a full backfill.
- The Dashboard and conditional formatting use English function names; non-English spreadsheet locales are untested.
- Data tabs are read fully on each run; extremely long histories will slow runs.

## License

MIT, see [LICENSE](LICENSE). Original project by [adamrangwala](https://github.com/adamrangwala).
