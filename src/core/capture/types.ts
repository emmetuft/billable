import type { CaptureSource } from '../../shared/types';

/** A single point-in-time observation from a platform adapter. Metadata only. */
export interface ActivitySnapshot {
  timestamp: string; // ISO 8601
  application: string;
  processId?: number;
  windowTitle: string;
  browserUrl?: string;
  browserTabTitle?: string;
  idleSeconds: number;
  /** True when the OS reports a locked screen; treated as idle immediately. */
  locked?: boolean;
}

/** Platform adapter contract. Implementations: macOS and Windows (main process). */
export interface ActivityCapture {
  readonly source: CaptureSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns null when no observation is possible (e.g. capture unavailable). */
  getCurrentActivity(): Promise<ActivitySnapshot | null>;
  /** Human-readable degradation notice (e.g. missing OS permission); null when healthy. */
  getWarning?(): string | null;
}
