import type { BatchStatus, ExceptionStatus, RunStatus } from '../api/types';

type Status = BatchStatus | ExceptionStatus | RunStatus;

const labels: Record<Status, string> = {
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  open: 'Open',
  investigating: 'Investigating',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}
