import type { TimekeeperApi } from '../../shared/ipc';

declare global {
  interface Window {
    timekeeper: TimekeeperApi;
  }
}
