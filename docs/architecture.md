# Architecture

A single-package Electron app. The plan's monorepo layout was simplified, as it allows. The key
boundary is **pure core logic vs. Electron/OS code**: everything in `src/core` is clock-free,
I/O-free and unit-tested.

```text
src/
├── shared/            Types, Zod schemas, IPC contract (used by every process)
├── core/              Pure logic, no Electron, no I/O
│   ├── capture/       ActivityCapture interface, ActivityRecorder, exclusions
│   ├── grouping/      Events → work sessions
│   ├── billing/       Rounding, overlap union, per-matter billing preview
│   └── time.ts        Local-day boundaries (DST-safe)
├── main/              Electron main process
│   ├── capture/       macOS adapter, Windows placeholder, CaptureService (polling loop)
│   ├── db/            better-sqlite3, migrations, Repository
│   ├── dayView.ts     Assembles the timeline view
│   ├── ipc.ts         Zod-validated IPC handlers
│   ├── tray.ts        Menu-bar/tray controls
│   └── index.ts       App lifecycle, window, power events
├── preload/           contextBridge → window.timekeeper
└── renderer/          React UI (timeline, matters, settings)
```

## Data flow

```text
Platform adapter ──snapshot──▶ ActivityRecorder ──changed events──▶ Repository (SQLite)
 (macOS / Windows)              (dedup, idle, gaps)                       │
                                                                          ▼
Renderer ◀──DayView── buildDayView: clip to day → groupSessions → billSessions
```

- **Evidence vs. interpretation.** `activity_events` is evidence. After insert, only `ended_at` and
  `idle_seconds` of the open event can change, and the repository enforces this. Manual matter choices
  live in a separate `matter_periods` table. Sessions and billing are computed from both, so
  regrouping never mutates evidence.
- **Recorder rules** (`core/capture/recorder.ts`):
  - The same window extends the open event.
  - A different window closes the open event and starts a new one.
  - When idle crosses the threshold, the active event is truncated back to when input stopped, and
    an explicit idle event covers the idle period.
  - A gap longer than `max(3 × poll, 60 s)`, a backwards clock change, or a null snapshot ends
    continuity. The gap is never bridged.
- **Session rules** (`core/grouping/sessions.ts`), in priority order:
  1. A session never spans two matters. The matter is the newest review correction covering the
     event, otherwise the matter selected while working, otherwise none.
  2. A manual split always starts a new session.
  3. More than `sessionGapMinutes` with no active work starts a new session, unless the attorney
     merged across that gap.
  4. App switches alone never split a session.

  Each session records its `startReason` (`first`, `matter_change`, `gap` or `manual_split`), and
  the timeline shows it at every boundary, so grouping is never a black box.

- **Matter changes** close the current event, so an event never spans two matters.

## Review corrections (Milestone 3)

The plan suggested a persisted `work_sessions` table. Instead, sessions stay **derived**: they are
recomputed from events on every read, and the attorney's corrections are stored as time-anchored
records in `session_corrections`:

| Kind            | Stored as                              | Effect                                                                                   |
| --------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `assign_matter` | span + matter (null = explicitly none) | Events starting in the span get this matter. The newest correction wins.                 |
| `split`         | instant                                | A new session starts at the first event at or after the instant.                         |
| `join`          | gap span                               | The inactivity split across that gap is suppressed. The gap still isn't counted as work. |
| `note`          | session start + text                   | The attorney's own description. Later feeds AI drafting as "user notes".                 |

Why this approach:

- **Evidence is never edited.** A test asserts that events are byte-identical after every kind of
  correction.
- **Live capture can't desync anything.** New events arriving for an open session need no
  reconciliation with a stored session row.
- **Every correction is visible, individually undoable, and audited.** Undo is a soft delete
  (`deleted_at`), and the audit log keeps the history.

Merging removes splits between the two sessions, adds a `join` if there's a gap, and adds an
`assign_matter` over the combined span if the matters differ. The merged session must keep one of
the two sessions' matters. Archived matters can't receive new assignments. Deleting activity also
deletes the corrections in that range.

Session IDs are `session_<first event id>`, which stays stable while a session's first event
doesn't change. Milestone 4 should key AI interpretations by session **span plus event IDs**, not by
session ID alone, so a regenerated grouping can't silently reattach a stale draft.

## Time entries (Milestone 5)

Unlike sessions, entries are **persisted** (`time_entries`), because once approved they are
billing records that must not change when the timeline is regrouped. Each captured entry
snapshots its evidence: event IDs, active intervals, span and observed time. This replaces the
plan's `work_session_id`, since session IDs aren't durable.

- **Drafting** (`core/entries/entries.ts`): `buildDraftUnits` turns assigned sessions into units
  (per session, or per matter-day with aggregation). `uncoveredUnits` excludes any unit whose
  events already appear in an entry of any status, so rejected work isn't re-drafted.
- **Sync**: `syncState` compares an entry's evidence with the current units. The result is
  `in_sync`, `changed` (events or matter differ, e.g. after a split or reassignment) or `missing`
  (evidence deleted or unassigned). Refresh re-snapshots a stale draft from the best-matching unit
  and keeps the narrative.
- **Matter** for captured entries is read-only in review. It comes from the timeline, so there's a
  single source of truth.
- **Billing**: drafts are calculated live (`entryBilling`). Approval stores `frozen_billing`.
- **Audit**: `Repository.saveEntry` writes a field-level diff (old → new) to `audit_log` on every
  change. The UI shows it as each entry's history.
- **Clipboard**: the format lives in `core/entries/clipboard.ts`. Main writes it with Electron's
  `clipboard` module, so the renderer needs no clipboard permission.

## Adding a capture platform

Implement `ActivityCapture` (`core/capture/types.ts`) and add a case to `createAdapter` in
`main/index.ts`. The adapter returns `ActivitySnapshot`s and should never fabricate data. The
Windows placeholder deliberately records nothing; the app has no simulated capture mode, so
fabricated activity can never be stored as real.

### Windows (Milestone 6) notes

Use `GetForegroundWindow` → `GetWindowTextW` + `GetWindowThreadProcessId` → process image name, and
`GetLastInputInfo` (or Electron `powerMonitor.getSystemIdleTime`) for idle. A small C# helper that
emits one JSON line per request over stdio keeps the IPC contract narrow. Build and validate it on
real Windows or a Windows CI runner, not Wine.

### Browser URLs

Not scraped. A small browser extension reporting the active tab's URL and title is the planned
enhancement. `browserUrl` and `browserTabTitle` are already optional throughout the schema.

## Testing

`npm test` runs Vitest with `TZ=America/New_York`, so DST cases are deterministic. The
`better-sqlite3` prebuilt binary is N-API, so repository tests run in plain Node against
`:memory:` databases.

Tests that need a realistic day use `src/test/fixtures/workday.ts`: a deterministic, fictional
workday replayed through the real `ActivityRecorder`. It is **test-only**: nothing in the app
imports it, so it is never bundled and can't write to a real database.

### Why there is no mock capture mode

The plan suggested a `MockActivityCapture` so the workflow could be built on a Mac without
Windows. It was used for Milestones 1–5, then removed from the product once real macOS capture
was working, so simulated activity can never be confused with real time. The schema only accepts
`macos` and `windows` as event sources.

## Database migrations

`src/main/db/migrations.ts` holds a single initial migration. No database has been deployed, so
during development the schema is edited in place: delete your local database after changing it.
The runner refuses a database whose recorded migrations don't match the build, with a message
saying to delete it. Once the app is installed on a real user's machine, migrations become
**append-only**: never edit a shipped migration; add a new one.
