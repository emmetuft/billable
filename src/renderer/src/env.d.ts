import type { BillableApi } from '../../shared/ipc';

declare global {
  interface Window {
    billable: BillableApi;
  }
}
