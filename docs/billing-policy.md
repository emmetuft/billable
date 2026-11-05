# Billing policy

All billing math lives in `src/core/billing/engine.ts`. It is deterministic, uses integer
milliseconds, and is unit-tested. **No LLM computes or decides billable time.**

> The defaults are placeholders. Confirm the firm's actual rules (open question #2 in the build plan)
> before relying on any billed figure.

## Settings

| Setting                | Default | Meaning                                                                                                                                                 |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incrementMinutes`     | 6       | Billing unit (6 min = 0.1 h).                                                                                                                           |
| `roundingMode`         | `up`    | `up` = ceiling. `nearest` = closest increment, with exact halves rounding up. `down` = floor.                                                           |
| `minimumMinutes`       | none    | If set, any non-zero work bills at least this much, rounded up to the increment.                                                                        |
| `allowTaskAggregation` | `false` | If true, a matter's sessions for the day are combined before rounding once. If false, each session is rounded independently and the results are summed. |
| `minimumConfidence`    | 0.7     | Reserved for AI drafts (Milestone 4).                                                                                                                   |

## Three kinds of duration

1. **Observed active**: the union of `active` events in a session. Idle, excluded and unrecorded
   time is never included. Overlapping events are never double-counted.
2. **Session span**: first to last active event. The difference from observed active time is shown
   as "not counted".
3. **Billed**: observed active time after the policy is applied. Each result carries a `trace`
   explaining how it was derived, and the UI shows it.

## Rules

- Zero (or negative) observed time always bills 0.
- Sessions without a matter are **never** billed. They must be assigned first.
- Rounding happens per session or per matter-day, never per window switch, because sessions
  already absorb short app switches.
- Days are local calendar days, so 23- and 25-hour DST days are handled. Activity spanning midnight
  is split between the two days.

## Worked examples (6-minute increments, round up)

| Observed                           | Billed            |
| ---------------------------------- | ----------------- |
| 1 min                              | 0.1 h             |
| 6 min 0 s                          | 0.1 h             |
| 6 min 1 s                          | 0.2 h             |
| 37 min                             | 0.7 h             |
| Two 4-min sessions, no aggregation | 0.1 + 0.1 = 0.2 h |
| Two 2-min sessions, aggregated     | 4 min → 0.1 h     |

## Time entries

Entries are created from timeline sessions that have a matter: one per session, or one per
matter-day when `allowTaskAggregation` is on. Unassigned work never becomes an entry.

- **Drafts are calculated live** from observed time under the current policy. **Approval freezes**
  the calculation, so later policy changes don't alter approved entries.
- **Adjustments** (write-downs or write-ups) must be a whole number of increments and need a reason.
  Both are kept in the billing explanation and the audit history. A write-up above the policy amount
  is flagged.
- **Manual entries** record time the app couldn't observe, such as calls. They are labelled as
  manual everywhere. Giving one a start time lets the app check it for overlaps.
- **Nonbillable** entries keep their time and are copied with `Billable = N`.

### What blocks approval

| Blocks approval                                  | Warns only                                             |
| ------------------------------------------------ | ------------------------------------------------------ |
| No matter                                        | Manual entry (time not observed)                       |
| Empty narrative                                  | Under 1 minute observed but rounded up to an increment |
| Timeline changed since drafting (refresh first)  | Billed time adjusted above the policy amount           |
| Underlying activity deleted or unassigned        | Any blocking issue that arises _after_ approval        |
| Overlaps another billable entry (double billing) |                                                        |
| Billable entry with no time                      |                                                        |

### Clipboard format

**Copy approved** copies approved entries that haven't been copied yet. Each entry also has
**Copy** / **Copy again**. The format is fixed:

- one line per entry, **tab-separated**, lines separated by **CRLF**, no header row;
- columns: `Date (YYYY-MM-DD)`, `Client`, `Matter`, `Hours`, `Billable (Y/N)`, `Narrative`;
- Hours are decimal billed hours with no trailing zeros (`0.7`, `1.5`, `1`, `0.25`);
- tabs and line breaks inside any field are collapsed to single spaces.

```text
2026-11-04⇥Contoso Ltd.⇥Supply Agreement Dispute⇥1.5⇥Y⇥Revised supply agreement redline…
```

Copied entries are marked **Copied**, with a timestamp. Nothing is ever submitted automatically.
Reopening a copied entry doesn't change what is already in the billing system, and the app warns
about this.

## Questions for the firm

- Round up, or to the nearest increment? Is there a minimum per entry?
- Should related tasks on a matter be combined into one daily entry, or kept as separate entries?
- Should very short activity (for example under 1 minute) be dropped rather than rounded up to 0.1?
  Today it is rounded up, which may overstate time.
- Which billing system is used, and does the column order above paste cleanly into it? (Open
  question #1 in the plan; the format is isolated in `src/core/entries/clipboard.ts`.)
- Which categories are nonbillable (administration, business development)?
