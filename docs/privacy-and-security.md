# Privacy and security

This app may handle confidential attorney–client information even though it captures metadata only.
**Do not use it with real client data until the firm has authorized desktop activity monitoring.**

## What is captured

| Captured                                                                         | Not captured                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Frontmost application name and process id                                        | Screenshots or screen recording                |
| Frontmost window title                                                           | Keystrokes or typed text                       |
| Start/end timestamps of each interval                                            | Document, email or web-page contents           |
| Idle duration (no keyboard/mouse input) and screen-lock state                    | Audio, camera, clipboard                       |
| Browser URL/tab title **only if** a future adapter supplies it (none does today) | Anything while monitoring is paused or stopped |

Polling happens every 15 s by default (configurable 5–60 s).

### Exclusions

Activity matching an excluded application, a window-title keyword (default: Incognito, Private
Browsing, InPrivate) or a domain is stored only as an **"Excluded"** interval with start/end time.
The app name, title, URL and process id are discarded before anything is written to disk.
Password managers and the lock screen are excluded by default. Idle and locked periods are also stored
without app or title metadata.

### macOS permissions

- App name and idle time need no permission (`lsappinfo`, Electron `powerMonitor`).
- Window titles need **Accessibility** permission (System Settings → Privacy & Security →
  Accessibility), and macOS asks once to let the app control **System Events**. If either is denied,
  capture records the app name only and shows a warning. Nothing else is requested.

## Where data is stored

- One SQLite database: `<userData>/timekeeper.sqlite3`
  - macOS: `~/Library/Application Support/ai-timekeeper/`
  - Windows: `%APPDATA%\ai-timekeeper\`
- The database and SQLite's `-wal`/`-shm` companion files are owner-only (`0600`). They are
  created that way before SQLite opens the database, so SQLite's companion files inherit it.
  The app also runs with a `077` umask, so everything else it writes (caches, logs) is private to
  the user too. On Windows, `chmod` has little effect and the per-user `%APPDATA%` ACLs apply.
- **Limitation:** the database is **not encrypted at rest** in this version. Rely on full-disk
  encryption (FileVault / BitLocker), which the firm should require anyway. SQLCipher or OS-keychain-
  wrapped keys are candidates for a later milestone.
- No telemetry, analytics or crash reporting is included, and the app makes no network calls today.

## What is sent to an AI provider

Nothing yet. AI drafting is Milestone 4. When added, it will send only the selected sessions'
app names, window titles, timestamps and minimal matter names/keywords, and only to a provider
the firm has approved. A vendor's "no training" statement alone is not approval.

## Controls

- Monitoring never starts on its own after installation: the user must click **Start**. Starting
  automatically at launch is an opt-in setting.
- A monitoring indicator is always visible in the menu bar/tray and in the app's status bar.
- Pause/resume and quit are available from the tray and the app.
- Closing the window does **not** stop monitoring. The app keeps running in the tray, and you quit
  it from the tray menu.
- Quitting (tray, Cmd+Q, OS logout) records a final observation, clears the matter selection and
  closes the database. A termination signal (SIGTERM/SIGINT) does the same cleanup synchronously
  and loses at most one poll interval of the current activity.
- Matter selection never carries over across restarts, so work is not silently attributed to
  yesterday's matter.

## Deletion and retention

- **Daily timeline → Delete day** removes events that started that day.
- **Settings → Delete all captured activity** removes all events and matter selections. Matters
  themselves are kept.
- **Settings → Data retention** automatically removes events older than N days at startup
  (0 = keep).
- Deletions and other significant actions are recorded in an `audit_log` table, which stores the
  action and counts but no captured content.

### Time entries

Time entries are billing records, so they are deliberately **not** removed by activity deletion or
by the retention setting. An approved entry keeps its narrative, frozen billing and audit history
even if the underlying activity is later deleted; it is then flagged as having missing evidence.
Whether entries should have their own retention period is a question for the firm.

Copying entries writes them to the **system clipboard**, where any other application can read
them. Clear or overwrite the clipboard after pasting if that matters under firm policy.

## Electron hardening

- Renderer: `contextIsolation`, `sandbox`, no Node integration, and a strict Content-Security-Policy.
- A single narrow preload bridge (`window.timekeeper`). Every IPC call is validated with Zod and
  rejected unless it comes from the app's own renderer.
- Navigation and new windows are blocked.
