import type {
  EntryPatch,
  ManualEntryInput,
  MatterInput,
  Range,
  SessionSpan,
  SettingsPatch,
} from './schemas';
import type {
  DayView,
  EntriesDay,
  EntryHistoryItem,
  Matter,
  MonitorStatus,
  Settings,
  TimeEntry,
} from './types';

/** IPC channel names. Every invoke channel is validated with Zod in src/main/ipc.ts. */
export const IPC = {
  getStatus: 'monitor:get-status',
  pause: 'monitor:pause',
  resume: 'monitor:resume',
  statusChanged: 'monitor:status-changed',
  listMatters: 'matters:list',
  createMatter: 'matters:create',
  updateMatter: 'matters:update',
  archiveMatter: 'matters:archive',
  setActiveMatter: 'matters:set-active',
  getDay: 'timeline:get-day',
  reassignSession: 'sessions:reassign',
  splitSession: 'sessions:split',
  mergeSessions: 'sessions:merge',
  setSessionNote: 'sessions:set-note',
  undoCorrection: 'sessions:undo-correction',
  listEntries: 'entries:list',
  generateDrafts: 'entries:generate-drafts',
  updateEntry: 'entries:update',
  approveEntry: 'entries:approve',
  reopenEntry: 'entries:reopen',
  rejectEntry: 'entries:reject',
  discardEntry: 'entries:discard',
  refreshEntry: 'entries:refresh',
  createManualEntry: 'entries:create-manual',
  copyEntries: 'entries:copy',
  entryHistory: 'entries:history',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  deleteActivity: 'data:delete-activity',
  deleteAllActivity: 'data:delete-all-activity',
} as const;

export type SessionRef = SessionSpan & { matterId: string | null };

/** The API exposed to the renderer as `window.billable`. */
export interface BillableApi {
  getStatus(): Promise<MonitorStatus>;
  pause(): Promise<MonitorStatus>;
  resume(): Promise<MonitorStatus>;
  onStatus(listener: (status: MonitorStatus) => void): () => void;
  listMatters(includeArchived?: boolean): Promise<Matter[]>;
  createMatter(input: MatterInput): Promise<Matter>;
  updateMatter(id: string, input: MatterInput): Promise<Matter>;
  archiveMatter(id: string): Promise<void>;
  setActiveMatter(id: string | null): Promise<MonitorStatus>;
  getDay(range: Range): Promise<DayView>;
  reassignSession(span: SessionSpan, matterId: string | null): Promise<void>;
  /** Start a new session at the event beginning at `at`. */
  splitSession(at: number): Promise<void>;
  mergeSessions(first: SessionRef, second: SessionRef, matterId: string | null): Promise<void>;
  setSessionNote(span: SessionSpan, note: string): Promise<void>;
  undoCorrection(id: string): Promise<void>;
  listEntries(date: string): Promise<EntriesDay>;
  /** Creates drafts for assigned timeline work with no entry yet. Returns how many. */
  generateDrafts(date: string): Promise<number>;
  updateEntry(id: string, patch: EntryPatch): Promise<TimeEntry>;
  approveEntry(id: string): Promise<TimeEntry>;
  reopenEntry(id: string): Promise<TimeEntry>;
  rejectEntry(id: string): Promise<TimeEntry>;
  discardEntry(id: string): Promise<void>;
  refreshEntry(id: string): Promise<TimeEntry>;
  createManualEntry(input: ManualEntryInput): Promise<TimeEntry>;
  /** Writes approved entries to the system clipboard (TSV) and marks them copied. */
  copyEntries(ids: string[]): Promise<{ text: string; count: number; billedMinutes: number }>;
  entryHistory(id: string): Promise<EntryHistoryItem[]>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  deleteActivity(range: Range): Promise<{ deleted: number }>;
  deleteAllActivity(): Promise<{ deleted: number }>;
}
