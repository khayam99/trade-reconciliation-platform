import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import type {
  ApiListResponse,
  ImportBatch,
  ReconciliationException,
  ReconciliationRunSummary,
} from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/AsyncState';
import { StatusBadge } from '../components/StatusBadge';
import { formatCount, formatTimestamp } from '../utils/formatters';

interface OverviewData {
  importBatchCount: number;
  completedRunCount: number;
  openExceptionCount: number;
  recentRuns: ReconciliationRunSummary[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: OverviewData };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load overview data.';
}

function BatchPair({ run }: { run: ReconciliationRunSummary }) {
  return (
    <div className="batch-pair">
      <span>
        <strong>{run.batchA.sourceSystem}</strong>
        <code>{run.batchA.id}</code>
      </span>
      <span>
        <strong>{run.batchB.sourceSystem}</strong>
        <code>{run.batchB.id}</code>
      </span>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: ReconciliationRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No reconciliation runs yet"
        message="Completed runs will appear here after two eligible batches are reconciled."
        action={
          <a className="secondary-button" href="#/reconcile">
            Start a reconciliation
          </a>
        }
      />
    );
  }

  return (
    <div
      className="table-scroll"
      role="region"
      aria-label="Recent reconciliation runs"
      tabIndex={0}
    >
      <table className="data-table recent-runs-table">
        <thead>
          <tr>
            <th scope="col">Run ID</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Source batches</th>
            <th scope="col" className="numeric-cell">
              Exceptions
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a className="run-link" href={`#/runs/${encodeURIComponent(run.id)}`}>
                  <code title={run.id}>{run.id}</code>
                </a>
              </td>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>
                <time dateTime={run.startedAt}>{formatTimestamp(run.startedAt)}</time>
              </td>
              <td>
                <BatchPair run={run} />
              </td>
              <td className="numeric-cell">{formatCount(run.exceptionCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewPage() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadState({ status: 'loading' });

    const countQuery = { limit: 1, offset: 0 };
    Promise.all([
      apiRequest<ApiListResponse<ImportBatch>>('/api/import-batches', {
        query: countQuery,
        signal: controller.signal,
      }),
      apiRequest<ApiListResponse<ReconciliationRunSummary>>('/api/reconciliation-runs', {
        query: { ...countQuery, status: 'completed' },
        signal: controller.signal,
      }),
      apiRequest<ApiListResponse<ReconciliationException>>('/api/exceptions', {
        query: { ...countQuery, status: 'open' },
        signal: controller.signal,
      }),
      apiRequest<ApiListResponse<ReconciliationRunSummary>>('/api/reconciliation-runs', {
        query: { limit: 5, offset: 0 },
        signal: controller.signal,
      }),
    ])
      .then(([batches, completedRuns, openExceptions, recentRuns]) => {
        if (!current) return;
        setLoadState({
          status: 'loaded',
          data: {
            importBatchCount: batches.pagination.total,
            completedRunCount: completedRuns.pagination.total,
            openExceptionCount: openExceptions.pagination.total,
            recentRuns: recentRuns.data,
          },
        });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setLoadState({ status: 'error', message: errorMessage(error) });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [reloadKey]);

  if (loadState.status === 'loading') {
    return <LoadingState label="Loading reconciliation overview…" />;
  }
  if (loadState.status === 'error') {
    return (
      <ErrorState message={loadState.message} onRetry={() => setReloadKey((key) => key + 1)} />
    );
  }

  const statistics = [
    { label: 'Import batches', value: loadState.data.importBatchCount, tone: 'neutral' },
    { label: 'Completed runs', value: loadState.data.completedRunCount, tone: 'green' },
    { label: 'Open exceptions', value: loadState.data.openExceptionCount, tone: 'amber' },
  ];

  return (
    <>
      <section className="summary-grid" aria-label="Operations overview statistics">
        {statistics.map((statistic) => (
          <article className="summary-card" key={statistic.label}>
            <div className="card-label">
              {statistic.label}
              <span className={`metric-dot ${statistic.tone}`} aria-hidden="true" />
            </div>
            <div className="card-value">{formatCount(statistic.value)}</div>
            <div className="card-note">From current API records</div>
          </article>
        ))}
      </section>

      <section className="data-panel" aria-labelledby="recent-runs-heading">
        <div className="panel-heading">
          <div>
            <h2 id="recent-runs-heading">Recent reconciliation runs</h2>
            <p>Latest runs across the ALPHA and BRAVO source batches</p>
          </div>
          <a className="text-link" href="#/reconcile">
            Start a run <span aria-hidden="true">→</span>
          </a>
        </div>
        <RecentRunsTable runs={loadState.data.recentRuns} />
      </section>
    </>
  );
}

export default OverviewPage;
