/**
 * Domain types shared by main, preload and renderer.
 * All timestamps are UTC epoch milliseconds; convert to local time only for display.
 */

export type CaptureSource = 'macos' | 'windows';

/** active = observed foreground work; idle = no input / screen locked; excluded = privacy-excluded app/site. */
export type EventKind = 'active' | 'idle' | 'excluded';

/** Observed evidence. Immutable after capture except for extending `endedAt` while the event is open. */
export interface ActivityEvent {
  id: string;
  startedAt: number;
  endedAt: number;
  kind: EventKind;
  application: string;
  processId: number | null;
  windowTitle: string;
  browserUrl: string | null;
  browserTabTitle: string | null;
  /** Largest idle duration observed while this event was open. */
  idleSeconds: number;
  source: CaptureSource;
}

export interface Matter {
  id: string;
  clientName: string;
  matterName: string;
  displayName: string;
  aliases: string[];
  keywords: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** An interval during which the attorney manually selected a matter as "active". */
export interface MatterPeriod {
  id: string;
  matterId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface Interval {
  startedAt: number;
  endedAt: number;
}

/**
 * A user correction layered over computed sessions. Evidence is never edited; corrections are
 * time-anchored so they survive regrouping, and each one can be individually undone.
 *  - assign_matter: events starting in [startedAt, endedAt) belong to matterId (null = no matter).
 *  - split:         force a session boundary at the first event starting at/after startedAt.
 *  - join:          suppress the inactivity split across the gap [startedAt, endedAt].
 *  - note:          attorney's own description for the session containing startedAt.
 */
export type CorrectionKind = 'assign_matter' | 'split' | 'join' | 'note';

export interface SessionCorrection {
  id: string;
  kind: CorrectionKind;
  startedAt: number;
  endedAt: number | null;
  matterId: string | null;
  note: string | null;
  createdAt: number;
}

/** Why a session begins where it does — shown in the UI so grouping is never a black box. */
export type SessionStartReason = 'first' | 'matter_change' | 'gap' | 'manual_split';

/** A computed grouping of related activity events. */
export interface WorkSession {
  id: string;
  startedAt: number;
  endedAt: number;
  matterId: string | null;
  /** 'selected' = chosen while working; 'corrected' = assigned afterwards in review. */
  matterSource: 'selected' | 'corrected' | 'none';
  status: 'needs_review' | 'classified';
  startReason: SessionStartReason;
  /** Time without active work before this session (null for the first session). */
  gapBeforeMs: number | null;
  note: string | null;
  /** Corrections that shaped this session (for display and undo). */
  correctionIds: string[];
  /** Active events that make up the session. */
  eventIds: string[];
  /** Observed active time (overlap-free union of active events). */
  activeMs: number;
  /** Time inside the session span that was idle, excluded, or not recorded. */
  untrackedMs: number;
  applications: { name: string; ms: number }[];
}

export type RoundingMode = 'up' | 'nearest' | 'down';

export interface BillingPolicy {
  incrementMinutes: number;
  minimumMinutes: number | null;
  roundingMode: RoundingMode;
  /** When true, all of a matter's work in a day is summed before rounding once. */
  allowTaskAggregation: boolean;
  /** Reserved for AI drafts (Milestone 4): below this, drafts are forced into review. */
  minimumConfidence: number;
}

export interface BillingCalculation {
  actualMs: number;
  billedMinutes: number;
  units: number;
  /** Human-readable explanation of how billedMinutes was derived. */
  trace: string[];
}

export interface Settings {
  captureSource: CaptureSource;
  startMonitoringOnLaunch: boolean;
  pollIntervalSeconds: number;
  idleThresholdMinutes: number;
  sessionGapMinutes: number;
  excludedApplications: string[];
  excludedDomains: string[];
  excludedTitleKeywords: string[];
  /** 0 = keep indefinitely. */
  retentionDays: number;
  billingPolicy: BillingPolicy;
}

export type MonitorState = 'running' | 'paused' | 'stopped';

export interface MonitorStatus {
  state: MonitorState;
  source: CaptureSource;
  current: Pick<ActivityEvent, 'kind' | 'application' | 'windowTitle' | 'startedAt'> | null;
  activeMatterId: string | null;
  warning: string | null;
}

export interface SessionBilling {
  sessionId: string;
  calculation: BillingCalculation | null;
}

export interface MatterBilling {
  matterId: string;
  calculation: BillingCalculation;
}

export interface DayView {
  startMs: number;
  endMs: number;
  events: ActivityEvent[];
  matterPeriods: MatterPeriod[];
  corrections: SessionCorrection[];
  sessions: WorkSession[];
  sessionBilling: SessionBilling[];
  matterBilling: MatterBilling[];
  totals: { activeMs: number; idleMs: number; excludedMs: number; unassignedActiveMs: number };
}

// ---- Milestone 5: time entries ----

/** 'exported' is reserved for a future billing-system integration. */
export type EntryStatus = 'draft' | 'approved' | 'copied' | 'exported' | 'rejected';

/**
 * A billing entry. Captured entries snapshot their evidence (event ids + active intervals)
 * from the timeline; manual entries record time the computer could not observe.
 */
export interface TimeEntry {
  id: string;
  /** Local calendar date, YYYY-MM-DD. */
  entryDate: string;
  source: 'captured' | 'manual';
  matterId: string | null;
  description: string;
  startAt: number | null;
  endAt: number | null;
  intervals: Interval[];
  evidenceEventIds: string[];
  actualMs: number;
  billable: boolean;
  /** Attorney's adjustment of billed time (e.g. a write-down), with a required reason. */
  billedOverrideMinutes: number | null;
  overrideReason: string | null;
  status: EntryStatus;
  /** Frozen at approval; null while a draft (drafts are always calculated live). */
  frozenBilling: BillingCalculation | null;
  approvedAt: number | null;
  copiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 'changed' = the timeline no longer matches this entry's evidence; 'missing' = evidence gone. */
export type EntrySync = 'in_sync' | 'changed' | 'missing' | 'manual';

export interface EntryFlag {
  code:
    | 'no_matter'
    | 'no_description'
    | 'stale'
    | 'overlap'
    | 'zero_time'
    | 'manual'
    | 'very_short'
    | 'adjusted_up';
  /** 'block' prevents approval; 'warn' needs the attorney's attention but not a fix. */
  severity: 'block' | 'warn';
  message: string;
}

export interface EntryView extends TimeEntry {
  calculation: BillingCalculation;
  sync: EntrySync;
  flags: EntryFlag[];
  /** Window-title evidence for drafting/checking the narrative (captured entries only). */
  evidence: Pick<ActivityEvent, 'id' | 'startedAt' | 'endedAt' | 'application' | 'windowTitle'>[];
  /** The attorney's timeline notes for the underlying sessions, if any. */
  sessionNotes: string[];
}

export interface EntriesDay {
  date: string;
  entries: EntryView[];
  /** Assigned timeline work with no entry yet (drafts can be created for it). */
  uncoveredActiveMs: number;
  /** Assigned activity without a matter, which can never become an entry until assigned. */
  unassignedActiveMs: number;
}

export interface EntryHistoryItem {
  at: number;
  action: string;
  detail: Record<string, unknown>;
}
