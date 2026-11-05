import type { ActivityCapture, ActivitySnapshot } from '../../core/capture/types';
import type { CaptureSource } from '../../shared/types';

/**
 * Placeholder for Milestone 6. The real adapter must be built and validated on Windows
 * (GetForegroundWindow / GetWindowText / GetWindowThreadProcessId / GetLastInputInfo),
 * likely via a small native helper with a narrow, documented IPC contract.
 * It deliberately does NOT fall back to mock data, so fake activity can never be recorded
 * as real activity.
 */
export class WindowsActivityCapture implements ActivityCapture {
  readonly source: CaptureSource = 'windows';

  async start(): Promise<void> {
    throw new Error('Windows capture is not implemented yet (Milestone 6).');
  }

  async stop(): Promise<void> {}

  async getCurrentActivity(): Promise<ActivitySnapshot | null> {
    return null;
  }
}
