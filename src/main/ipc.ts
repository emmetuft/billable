import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/ipc';
import {
  EntryIdsSchema,
  IdSchema,
  IsoDateSchema,
  ManualEntrySchema,
  MatterInputSchema,
  MergeSchema,
  mergeSettings,
  NoteSchema,
  RangeSchema,
  ReassignSchema,
  SettingsPatchSchema,
  SplitSchema,
  UpdateEntrySchema,
  UpdateMatterSchema,
} from '../shared/schemas';
import {
  approveEntry,
  copyEntries,
  createManualEntry,
  discardEntry,
  generateDrafts,
  listEntries,
  refreshEntry,
  rejectEntry,
  reopenEntry,
  updateEntry,
} from './entries';
import { mergeSessions, reassignSession, setSessionNote, splitSessionAt } from './corrections';
import type { CaptureService } from './capture/service';
import type { Repository } from './db/repository';
import { buildDayView, writeSampleDay } from './dayView';

/**
 * Every handler validates its arguments with Zod before touching the database,
 * and rejects calls that don't come from our own renderer.
 */
export function registerIpc(
  repo: Repository,
  capture: CaptureService,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
): void {
  const handle = <S extends z.ZodType>(
    channel: string,
    schema: S,
    fn: (arg: z.infer<S>) => unknown,
  ) =>
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
      return fn(parsed.data);
    });
  const none = z.undefined();

  handle(IPC.getStatus, none, () => capture.status());
  handle(IPC.pause, none, async () => (await capture.pause(), capture.status()));
  handle(IPC.resume, none, async () => (await capture.resume(), capture.status()));

  handle(IPC.listMatters, z.boolean().optional(), (includeArchived) =>
    repo.listMatters(includeArchived),
  );
  handle(IPC.createMatter, MatterInputSchema, (input) => repo.createMatter(input));
  handle(IPC.updateMatter, UpdateMatterSchema, ({ id, input }) => repo.updateMatter(id, input));
  handle(IPC.archiveMatter, IdSchema, async (id) => {
    if (capture.status().activeMatterId === id) await capture.setActiveMatter(null);
    repo.archiveMatter(id);
  });
  handle(IPC.setActiveMatter, IdSchema.nullable(), async (id) => {
    await capture.setActiveMatter(id);
    return capture.status();
  });

  handle(IPC.getDay, RangeSchema, (r) => buildDayView(repo, r.startMs, r.endMs));

  handle(IPC.reassignSession, ReassignSchema, ({ span, matterId }) => {
    reassignSession(repo, span, matterId);
  });
  handle(IPC.splitSession, SplitSchema, ({ at }) => {
    splitSessionAt(repo, at);
  });
  handle(IPC.mergeSessions, MergeSchema, ({ first, second, matterId }) =>
    mergeSessions(repo, first, second, matterId),
  );
  handle(IPC.setSessionNote, NoteSchema, ({ span, note }) => setSessionNote(repo, span, note));
  handle(IPC.undoCorrection, IdSchema, (id) => repo.undoCorrection(id));

  handle(IPC.listEntries, IsoDateSchema, (date) => listEntries(repo, date));
  handle(IPC.generateDrafts, IsoDateSchema, (date) => generateDrafts(repo, date));
  handle(IPC.updateEntry, UpdateEntrySchema, ({ id, patch }) => updateEntry(repo, id, patch));
  handle(IPC.approveEntry, IdSchema, (id) => approveEntry(repo, id));
  handle(IPC.reopenEntry, IdSchema, (id) => reopenEntry(repo, id));
  handle(IPC.rejectEntry, IdSchema, (id) => rejectEntry(repo, id));
  handle(IPC.discardEntry, IdSchema, (id) => discardEntry(repo, id));
  handle(IPC.refreshEntry, IdSchema, (id) => refreshEntry(repo, id));
  handle(IPC.createManualEntry, ManualEntrySchema, (input) => createManualEntry(repo, input));
  handle(IPC.copyEntries, EntryIdsSchema, (ids) =>
    copyEntries(repo, ids, (text) => clipboard.writeText(text)),
  );
  handle(IPC.entryHistory, IdSchema, (id) => repo.entryHistory(id));

  handle(IPC.getSettings, none, () => repo.getSettings());
  handle(IPC.updateSettings, SettingsPatchSchema, async (patch) => {
    const next = mergeSettings(repo.getSettings(), patch);
    repo.saveSettings(next);
    await capture.reload();
    return next;
  });

  handle(IPC.generateSampleDay, z.number().int(), (startMs) => ({
    events: writeSampleDay(repo, startMs),
  }));
  handle(IPC.deleteActivity, RangeSchema, (r) => ({
    deleted: repo.deleteEventsInRange(r.startMs, r.endMs),
  }));
  handle(IPC.deleteAllActivity, none, async () => {
    await capture.setActiveMatter(null);
    return { deleted: repo.deleteAllEvents() };
  });
}
