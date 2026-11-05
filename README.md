# Billable

A local-first desktop app that helps an attorney reconstruct their workday from **metadata only**
(app, window title, timestamps and idle time) and turn it into reviewable billing entries. It assists
with timekeeping. It never decides what is billable and never submits anything.

See [`billable-build-plan.md`](billable-build-plan.md) for the full plan, plus
[architecture](docs/architecture.md), [privacy & security](docs/privacy-and-security.md) and
[billing policy](docs/billing-policy.md).

## Status

| Milestone                                                           | State                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1. Foundation: Electron, React, TS, SQLite, migrations, safe IPC    | ✅                                                                                                                                |
| 2. Metadata recorder: macOS adapter, idle, exclusions, pause/resume | ✅ (simulated capture removed; see docs/architecture.md)                                                                          |
| 3. Timeline & matters                                               | ✅ Timeline, matter create/edit/select, reassign, split, merge, notes, undo                                                       |
| 4. AI draft descriptions                                            | Not started                                                                                                                       |
| 5. Billing engine & entry review                                    | ✅ Drafts from timeline, review flags, approve/reopen/reject, adjustments, manual entries, overlap guard, TSV copy, audit history |
| 6. Windows capture                                                  | Interface ready. Adapter is a placeholder and must be built on Windows.                                                           |

## Requirements

- Node **22.12+** (pinned to 22.23.4 in `.nvmrc`; run `nvm use`)
- macOS with Xcode Command Line Tools for development

## Commands

```bash
nvm use
npm install          # also rebuilds native deps for Electron
npm run dev          # run with hot reload
npm test             # unit tests (Vitest)
npm run typecheck
npm run lint
npm run build        # production bundle in out/
npm run package:mac  # installer in release/ (unsigned)
```

To run against a throwaway database: `BILLABLE_DATA_DIR=/tmp/billable-test npm run dev`.

## Trying it

1. Launch with `npm run dev`. Monitoring does **not** start on its own: click **Start** in the
   status bar. (Turn on _Start monitoring when the app launches_ in Settings if you want it to.)
2. The first time, macOS asks to let the app control **System Events**. For window titles, also
   grant **Accessibility** (System Settings → Privacy & Security → Accessibility). In dev mode the
   entry may be listed under your terminal or "Electron".
3. Create your matters, pick the active matter as you work, and review the day on
   **Daily timeline**.
4. On **Review entries**, click **Create drafts**, write narratives, approve, and use
   **Copy approved** to paste into your billing system.
