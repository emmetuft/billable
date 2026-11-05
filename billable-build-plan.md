# Billable --- Build Plan

## 1. Product goal

Build a local-first desktop application that helps an attorney
reconstruct their workday and produce accurate, editable legal billing
entries.

The attorney currently records time manually in six-minute billing
increments. The app should reduce the effort required to create time
entries by collecting activity metadata, grouping related work, drafting
conservative billing narratives with AI, and applying billing rules
deterministically.

**The app assists with timekeeping; it does not independently decide
what is billable or submit entries.** The attorney must review and
approve every entry before copying it into the firm's billing system.

## 2. MVP scope

### In scope

-   Desktop application built with Electron, React, and TypeScript.
-   macOS development support and Windows target support.
-   Metadata-only activity capture:
    -   Active application/process.
    -   Active window title.
    -   Timestamps and activity durations.
    -   Idle duration / idle periods.
    -   Browser tab title and URL where available.
-   Local SQLite database.
-   Daily activity timeline.
-   Manual client/matter selection.
-   Basic grouping of related activity into work sessions.
-   AI-assisted classification and draft billing narratives.
-   Confidence indicators and an explicit review queue for uncertain
    activity.
-   Configurable billing policy, including six-minute increments.
-   Editable time-entry review screen.
-   Copy individual entries or a group of entries to the clipboard.

### Explicitly out of scope for the MVP

-   Screenshot capture or screen recording.
-   OCR or vision models.
-   Keystroke logging or capture of typed content.
-   Audio or call recording.
-   Automatic submission to billing software.
-   Automatic email/document content ingestion.
-   Complex integrations with practice-management or billing platforms.
-   Automatic inference presented as fact when the evidence is
    ambiguous.

Keep the architecture extensible so screenshots or additional metadata
sources could be added later, but do not implement them now.

## 3. Product principles

1.  **Metadata only.** Capture application/window/browser metadata and
    timestamps. Do not capture screenshots, keystrokes, typed text, or
    audio.
2.  **Local-first.** Store activity records and user data locally by
    default. Minimize what is sent to an AI provider.
3.  **Human approval.** Every generated entry is a draft until the
    attorney reviews and approves it.
4.  **Evidence-based descriptions.** Do not claim that a document was
    read, drafted, researched, or edited merely because it was open. Use
    cautious descriptions and flag uncertainty.
5.  **Separate evidence from interpretation.** Preserve raw activity
    events separately from AI interpretations and final billing entries.
6.  **Deterministic billing calculations.** Implement time rounding,
    aggregation, overlap handling, and billing increments in ordinary
    application code---not in an LLM.
7.  **No fabricated time.** Distinguish observed activity duration from
    inferred work duration and billed duration.
8.  **Visible control.** Make monitoring status obvious and provide
    pause/resume and quit controls.
9.  **Privacy by design.** Provide exclusions for sensitive applications
    and sites. Avoid collecting more information than needed.
10. **Firm-policy configurable.** Do not assume a particular firm's
    billing rules, approved AI provider, or data-retention policy.

## 4. Suggested technology stack

-   **Desktop shell:** Electron
-   **UI:** React + TypeScript
-   **Build tooling:** Vite
-   **Local database:** SQLite, using a maintained Node binding such as
    `better-sqlite3`
-   **Validation:** Zod
-   **Package manager:** npm or pnpm; choose one and use it consistently
-   **Testing:** Vitest for unit tests; Playwright or Electron-focused
    integration tests where useful
-   **Packaging:** electron-builder
-   **AI:** Provider-agnostic adapter; do not couple application logic
    to one model vendor

Use a monorepo only if it remains simple. Avoid premature abstraction
and unnecessary services.

## 5. Proposed repository structure

``` text
billable/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   │   ├── activity/
│       │   │   ├── database/
│       │   │   ├── ipc/
│       │   │   └── tray/
│       │   ├── preload/
│       │   └── renderer/
│       │       ├── components/
│       │       ├── pages/
│       │       └── hooks/
│       └── package.json
├── packages/
│   ├── activity-capture/
│   │   └── src/
│   │       ├── interfaces/
│   │       ├── macos/
│   │       ├── windows/
│   │       └── mock/
│   ├── ai/
│   │   └── src/
│   ├── billing/
│   │   └── src/
│   ├── database/
│   │   └── src/
│   └── shared/
│       └── src/
├── docs/
│   ├── architecture.md
│   ├── privacy-and-security.md
│   └── billing-policy.md
├── package.json
└── README.md
```

The coding agent may simplify this structure if a smaller layout is more
practical. Keep platform-specific capture code isolated from shared
application logic.

## 6. Cross-platform activity capture

The app is being developed on macOS, but the attorney's target computer
is Windows. Design a shared interface and implement separate platform
adapters.

### Shared interface

Start with an interface similar to:

``` ts
export interface ActivitySnapshot {
  timestamp: string;          // ISO 8601
  application: string;        // Human-readable app name
  processId?: number;
  windowTitle: string;
  browserUrl?: string;
  browserTabTitle?: string;
  idleSeconds: number;
}

export interface ActivityCapture {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentActivity(): Promise<ActivitySnapshot | null>;
}
```

Adjust the interface as implementation details become clear. Keep it
small and platform-neutral.

### Capture behavior

-   Detect active-window changes and record them promptly.
-   Poll at a modest interval (initially around 15--30 seconds) to
    measure activity and idle time.
-   Avoid inserting duplicate events when the active application/window
    has not changed.
-   Record enough timestamps to reconstruct intervals accurately.
-   Represent idle periods explicitly; do not silently treat them as
    billable work.
-   Handle sleep, lock screen, app shutdown, and system clock changes
    gracefully.
-   Do not record keystrokes or the content of typed text.
-   Provide a configurable idle threshold and make it clear in the UI
    when the user is considered idle.

### Browser metadata

Browser URLs and tab titles may not be reliably accessible from every
browser using generic OS APIs. Do not build a brittle solution around
scraping browser window titles.

For the first pass: - Capture the browser application and window
title. - Investigate a small browser extension as a later enhancement
for reliable active-tab URL/title metadata. - Keep browser metadata
optional in the shared interface. - Never block the initial activity
recorder on browser-extension support.

### Platform implementation

**macOS** - Implement a macOS adapter sufficient for local development
and testing. - Investigate required macOS permissions and communicate
them clearly to the user. - Use the least invasive supported APIs.

**Windows** - Implement and validate the Windows adapter on an actual
Windows environment. - Investigate Win32 foreground-window APIs (for
example, `GetForegroundWindow`) and appropriate APIs for process/window
metadata and idle time. - A small native C# helper may be appropriate if
Electron/Node APIs are insufficient. Keep its IPC contract narrow and
documented. - Do not assume the macOS implementation will work on
Windows.

### Mock implementation

Build `MockActivityCapture` early. It should replay a deterministic
sequence of realistic events so the timeline, grouping, AI, and billing
workflows can be developed on a Mac without depending on Windows.

## 7. Data model

Use migrations and stable identifiers. Store timestamps in UTC (ISO 8601
or integer epoch) and convert to local time for display.

Suggested initial entities:

### `matters`

-   `id`
-   `client_name`
-   `matter_name`
-   `display_name`
-   `aliases` (JSON or normalized related table)
-   `keywords` (JSON or normalized related table)
-   `created_at`
-   `updated_at`
-   `archived_at`

Only store matter information needed to help classify activity. Do not
assume the app has permission to ingest full client files or email
contents.

### `activity_events`

-   `id`
-   `started_at`
-   `ended_at`
-   `application`
-   `process_id`
-   `window_title`
-   `browser_url` (nullable)
-   `browser_tab_title` (nullable)
-   `idle_seconds`
-   `source` (e.g. `macos`, `windows`, `mock`)
-   `created_at`

Events should represent observed activity and remain unchanged after
capture, except for carefully controlled corrections or annotations with
an audit trail.

### `work_sessions`

-   `id`
-   `started_at`
-   `ended_at`
-   `matter_id` (nullable)
-   `status` (e.g. `unclassified`, `needs_review`, `classified`,
    `approved`)
-   `created_at`
-   `updated_at`

A work session groups related activity events. A session may contain
multiple applications and multiple short intervals.

### `activity_interpretations`

-   `id`
-   `work_session_id`
-   `matter_id` (nullable)
-   `activity_type`
-   `draft_description`
-   `confidence`
-   `reasoning_summary` (brief, evidence-grounded explanation; do not
    store hidden chain-of-thought)
-   `evidence_event_ids`
-   `needs_review`
-   `model_provider`
-   `model_name`
-   `created_at`

Treat interpretations as replaceable drafts. Preserve prior versions if
regenerated or edited.

### `time_entries`

-   `id`
-   `work_session_id` (nullable if manually created)
-   `matter_id`
-   `description`
-   `actual_minutes`
-   `billed_minutes`
-   `billing_units`
-   `status` (`draft`, `approved`, `copied`, `exported`)
-   `start_at`
-   `end_at`
-   `created_at`
-   `updated_at`

### Additional tables to consider

-   `settings`
-   `billing_policies`
-   `excluded_applications`
-   `excluded_domains`
-   `audit_log`

Do not overbuild the schema before the core workflow works. Use
migrations so changes remain manageable.

## 8. Activity grouping and matter classification

The app should turn raw events into understandable work sessions.

### Initial grouping heuristics

Start with simple, transparent rules: - Adjacent events in the same
application/document or same likely matter may belong to one session. -
Short switches between related applications should not automatically
split a session. - Long gaps and idle periods should break or suspend
sessions. - A configurable inactivity gap can split sessions. - Avoid
merging unrelated matters merely because the same application was used.

Expose grouping decisions in the UI so the attorney can correct them.

### Matter assignment

Start with manual matter selection: - Let the attorney select the active
matter from the tray/menu or main UI. - Associate subsequent events with
that matter until changed or paused. - Allow a session's matter to be
corrected after capture. - Later, use matter aliases, document names,
participants, URLs, and historical corrections as classification
hints. - If uncertain, leave the matter unassigned and ask for review.

Never silently assign a low-confidence matter.

## 9. AI-assisted interpretation

AI should transform grouped metadata into draft work descriptions---not
manufacture facts.

### Provider abstraction

``` ts
export interface AIProvider {
  classifyActivity(input: ActivityBatch): Promise<ActivityResult>;
  generateTimeEntries(input: WorkSession[]): Promise<TimeEntryDraft[]>;
}
```

Define concrete types and validate all model responses with Zod.

### Suggested input

-   Work-session start/end.
-   Ordered application/window-title/URL events.
-   Idle intervals and gaps.
-   Manually selected matter, if any.
-   Candidate matters and only the minimal aliases/keywords needed.
-   User corrections or notes, if provided.

Do not send full client documents, emails, typed text, or other content
that the app has not explicitly been authorized to process.

### Suggested structured output

-   `matterId` (nullable)
-   `activityType` (e.g. research, drafting, reviewing, communication,
    administration, unknown)
-   `description`
-   `startAt`
-   `endAt`
-   `confidence` (0--1)
-   `needsReview`
-   `evidenceEventIds`
-   `uncertaintyNote`

The app must reject invalid or unsupported event IDs and validate
timestamps and matter IDs.

### Narrative quality rules

-   Use concise, neutral, professional billing language.
-   Describe the apparent task, not unsupported conclusions.
-   Do not claim a document was reviewed or drafted solely because its
    window was active.
-   Do not invent communications, legal analysis, research results, or
    work product.
-   Do not convert idle time or unexplained gaps into work.
-   Flag ambiguous activity for attorney review.
-   Support user edits and learn only from explicitly retained
    corrections, subject to privacy policy.

### AI privacy

Before connecting real client matters to a cloud model, obtain the
firm's approval and confirm applicable confidentiality, retention,
data-processing, and vendor requirements. A vendor's no-training
statement alone does not establish that use is permitted.

Keep the provider replaceable so an approved cloud service or local
model can be selected later.

## 10. Billing engine

All billing calculations must be deterministic and independently tested.

Create a configurable policy rather than hardcoding assumptions.
Potential settings:

``` ts
export interface BillingPolicy {
  incrementMinutes: number;        // e.g. 6
  minimumMinutes?: number;
  roundingMode: "up" | "nearest" | "down";
  allowTaskAggregation: boolean;
  minimumConfidence: number;
}
```

This is only a starting point. Confirm the firm's actual rules before
treating any configuration as correct.

The billing engine should: - Preserve actual observed duration
separately from billed duration. - Apply the configured increment and
rounding policy. - Handle overlapping sessions without
double-counting. - Support nonbillable periods. - Support the firm's
rules for aggregating related tasks. - Keep a traceable record of how
billed duration was calculated. - Avoid rounding every tiny activity
switch independently if firm policy instead rounds aggregated work. -
Never let an LLM calculate or decide final billable minutes.

The UI should make actual duration and billed duration distinguishable.

## 11. User experience

Keep the UI simple and focused on reducing daily review effort.

### Tray / menu-bar experience

-   Monitoring status: on, paused, or stopped.
-   Current active application/window.
-   Current selected matter.
-   Pause/resume control.
-   Quick matter selector.
-   Open daily review.
-   Quit.

Monitoring must be visible and easy to pause.

### Daily timeline

-   Chronological list of captured activity.
-   Grouped sessions with start/end and duration.
-   Application and window-title evidence.
-   Visible idle periods and unexplained gaps.
-   Matter assignment and confidence.
-   Ability to merge, split, relabel, or reassign sessions.

### Time-entry review

For each draft: - Matter/client. - Editable billing narrative. -
Start/end or duration. - Actual minutes and billed minutes. - Confidence
and review warning. - Link to supporting activity events. - Approve,
edit, reject, or mark nonbillable.

Provide: - Copy one entry. - Copy all approved entries. - A predictable
plain-text or tab-separated clipboard format. - Clear feedback about
what was copied.

Do not automatically submit entries to the firm's billing platform.

## 12. Privacy, security, and controls

This app may handle confidential attorney-client information, even when
it captures metadata only.

MVP safeguards: - Monitoring indicator always visible while capture is
active. - Pause/resume and quit controls. - Exclusion list for
applications and domains. - Avoid capturing lock-screen and
password-manager activity where possible. - Local database access
restricted to the current user. - Protect sensitive settings and API
credentials using OS-appropriate secure storage. - Encrypt sensitive
local data where practical; document any limitations. - Minimize data
sent to AI providers. - Provide configurable local data retention and
deletion. - Keep an audit trail for changes to approved time entries. -
Do not include client/matter metadata in crash reports or analytics. -
Do not enable telemetry by default. - Obtain firm authorization before
deployment or use with real client data.

Document exactly what is captured, where it is stored, what is sent to
an AI provider, and how data can be deleted.

## 13. Development plan and milestones

### Milestone 1 --- Project foundation

-   Set up Electron + React + TypeScript.
-   Configure linting, formatting, type checking, and tests.
-   Establish main/preload/renderer boundaries and safe IPC.
-   Create shared types and Zod schemas.
-   Add SQLite connection and migrations.
-   Build basic settings and monitoring-status UI.

**Acceptance criteria:** App launches on macOS, creates its local
database, and displays a working shell UI.

### Milestone 2 --- Metadata activity recorder

-   Implement `ActivityCapture` interface.
-   Implement `MockActivityCapture`.
-   Implement macOS metadata capture.
-   Record active application, process, window title, timestamps, and
    idle duration.
-   Detect changes and avoid duplicate events.
-   Add pause/resume and excluded-app settings.
-   Persist events to SQLite.

**Acceptance criteria:** A normal work session produces a coherent local
event history without screenshots, keystrokes, or audio.

### Milestone 3 --- Daily timeline and manual matters

-   Build daily timeline.
-   Display activity intervals, gaps, and idle periods.
-   Add matter creation and selection.
-   Support manual assignment and correction.
-   Add basic session grouping and merge/split controls.

**Acceptance criteria:** The attorney can inspect a day and manually
turn observed activity into correctly assigned work sessions.

### Milestone 4 --- AI draft descriptions

-   Define provider abstraction and structured prompts.
-   Implement one approved/test provider or a deterministic mock.
-   Send only selected metadata and minimal matter context.
-   Validate model output.
-   Show draft narrative, confidence, and evidence.
-   Add edit/regenerate/reject actions.

**Acceptance criteria:** AI can produce conservative drafts from sample
metadata, and uncertain cases are visibly flagged.

### Milestone 5 --- Billing calculations and review

-   Implement configurable billing policy.
-   Add overlap detection and aggregation rules.
-   Calculate billed units deterministically.
-   Build editable entry-review UI.
-   Add copy-one/copy-approved-entries actions.
-   Add audit history for approval and edits.

**Acceptance criteria:** Unit tests demonstrate correct calculations for
six-minute increments and configured edge cases; the attorney can
approve and copy entries.

### Milestone 6 --- Windows implementation and validation

-   Implement Windows activity capture, using native helper code if
    necessary.
-   Validate active window, process, idle, and app-switch behavior on
    Windows.
-   Build Windows installer using a Windows machine or CI runner.
-   Test permissions, startup/shutdown, sleep/resume, and exclusions.
-   Fix platform-specific issues.

**Acceptance criteria:** The app installs and captures metadata reliably
on the attorney's Windows computer.

### Milestone 7 --- Parallel trial and refinement

Run the app alongside the attorney's existing timekeeping process for
approximately two weeks.

Compare: - Matter assignment accuracy. - Activity/session grouping
accuracy. - Missed work and unexplained gaps. - Actual duration versus
attorney's recollection. - Narrative usefulness and accuracy. - Time
required to review and finalize entries.

Optimize for reducing review effort while preserving accuracy---not for
maximizing the percentage of entries generated automatically.

## 14. Development on macOS, deployment to Windows

The developer is currently working on a Mac, while the attorney's target
machine is Windows.

-   Build the shared Electron/React/TypeScript app on macOS.
-   Use `MockActivityCapture` to develop the full workflow without
    Windows.
-   Implement and test the macOS adapter for local development.
-   Keep Windows capture behind the same interface.
-   Build and test Windows native code and installers on Windows,
    preferably with a Windows CI runner.
-   Do not rely on Wine to validate Windows capture behavior.
-   A separate Windows development machine is not required at the
    beginning, but access to a Windows test environment will be required
    before release.

## 15. Testing strategy

Include tests from the beginning.

### Unit tests

-   Event deduplication.
-   Interval creation and closing.
-   Idle-period handling.
-   Session grouping and splitting.
-   Matter assignment.
-   Timestamp/time-zone behavior.
-   Billing rounding and aggregation.
-   Overlap prevention.
-   AI response validation.
-   Clipboard formatting.

### Integration tests

-   Capture event → database persistence → timeline display.
-   Session grouping → AI draft → user edit → approved entry.
-   Pause/resume and excluded application behavior.
-   Database migration and recovery.

### Important edge cases

-   Computer sleeps or locks.
-   App crashes while tracking.
-   Active window changes rapidly.
-   Same document is opened in multiple applications.
-   Browser title changes while URL remains the same.
-   Long idle period in the middle of a work session.
-   User switches matters mid-session.
-   Activity spans midnight.
-   Daylight-saving time changes.
-   Overlapping or concurrent activity.
-   Missing or malformed browser metadata.
-   AI returns invalid IDs or unsupported claims.

## 16. Open questions to resolve before real-world use

Do not block the prototype on these, but resolve them before relying on
generated entries:

1.  What billing software does the firm use, and what clipboard/import
    format is most useful?
2.  What are the firm's exact six-minute rounding, aggregation,
    minimum-time, and nonbillable rules?
3.  Does the firm permit desktop activity monitoring?
4.  Which AI providers, if any, are approved for confidential
    client-related metadata?
5.  Is the computer firm-managed, and are there IT restrictions on
    installing a desktop app or native helper?
6.  Which browsers does the attorney use?
7.  Does the attorney prefer selecting a matter manually throughout the
    day or reviewing suggested matter assignments later?

## 17. Instructions to the coding agent

Build this incrementally. Do not attempt to implement the entire product
in one pass.

Start with **Milestone 1**, then Milestone 2 using mock data before
implementing platform-specific capture. Keep the first vertical slice
small and runnable.

Prioritize: - A working app over elaborate architecture. - Clear
TypeScript interfaces. - Small, testable modules. - Safe Electron IPC
and context isolation. - Database migrations. - Deterministic tests for
time calculations. - Visible capture controls and privacy safeguards.

Do not add screenshot capture, screen recording, OCR, keystroke logging,
audio recording, automatic billing submission, or unapproved client-data
integrations. If a requirement is ambiguous, implement the safest
minimal behavior and document the question rather than inventing a
policy.

The first deliverable should be a runnable macOS app with a mock
activity timeline and a clean architecture for adding real macOS and
Windows metadata capture.
