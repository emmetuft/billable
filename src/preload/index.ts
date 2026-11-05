import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type TimekeeperApi } from '../shared/ipc';
import type { MonitorStatus } from '../shared/types';

/** The only bridge between the sandboxed renderer and the main process. */
const api: TimekeeperApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  pause: () => ipcRenderer.invoke(IPC.pause),
  resume: () => ipcRenderer.invoke(IPC.resume),
  onStatus: (listener) => {
    const wrapped = (_e: unknown, status: MonitorStatus) => listener(status);
    ipcRenderer.on(IPC.statusChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.statusChanged, wrapped);
  },
  listMatters: (includeArchived) => ipcRenderer.invoke(IPC.listMatters, includeArchived),
  createMatter: (input) => ipcRenderer.invoke(IPC.createMatter, input),
  updateMatter: (id, input) => ipcRenderer.invoke(IPC.updateMatter, { id, input }),
  archiveMatter: (id) => ipcRenderer.invoke(IPC.archiveMatter, id),
  setActiveMatter: (id) => ipcRenderer.invoke(IPC.setActiveMatter, id),
  getDay: (range) => ipcRenderer.invoke(IPC.getDay, range),
  reassignSession: (span, matterId) => ipcRenderer.invoke(IPC.reassignSession, { span, matterId }),
  splitSession: (at) => ipcRenderer.invoke(IPC.splitSession, { at }),
  mergeSessions: (first, second, matterId) =>
    ipcRenderer.invoke(IPC.mergeSessions, { first, second, matterId }),
  setSessionNote: (span, note) => ipcRenderer.invoke(IPC.setSessionNote, { span, note }),
  undoCorrection: (id) => ipcRenderer.invoke(IPC.undoCorrection, id),
  listEntries: (date) => ipcRenderer.invoke(IPC.listEntries, date),
  generateDrafts: (date) => ipcRenderer.invoke(IPC.generateDrafts, date),
  updateEntry: (id, patch) => ipcRenderer.invoke(IPC.updateEntry, { id, patch }),
  approveEntry: (id) => ipcRenderer.invoke(IPC.approveEntry, id),
  reopenEntry: (id) => ipcRenderer.invoke(IPC.reopenEntry, id),
  rejectEntry: (id) => ipcRenderer.invoke(IPC.rejectEntry, id),
  discardEntry: (id) => ipcRenderer.invoke(IPC.discardEntry, id),
  refreshEntry: (id) => ipcRenderer.invoke(IPC.refreshEntry, id),
  createManualEntry: (input) => ipcRenderer.invoke(IPC.createManualEntry, input),
  copyEntries: (ids) => ipcRenderer.invoke(IPC.copyEntries, ids),
  entryHistory: (id) => ipcRenderer.invoke(IPC.entryHistory, id),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  generateSampleDay: (startMs) => ipcRenderer.invoke(IPC.generateSampleDay, startMs),
  deleteActivity: (range) => ipcRenderer.invoke(IPC.deleteActivity, range),
  deleteAllActivity: () => ipcRenderer.invoke(IPC.deleteAllActivity),
};

contextBridge.exposeInMainWorld('timekeeper', api);
