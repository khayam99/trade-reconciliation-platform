import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import type {
  ApiDataResponse,
  ReconciliationOutcome,
  ReconciliationResult,
  ReconciliationRunDetails,
} from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/AsyncState';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { formatCount, formatTimestamp } from '../utils/formatters';

const PAGE_SIZE = 25;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: ReconciliationRunDetails };

const outcomeLabels: Record<ReconciliationOutcome, string> = {
  exact_match: 'Exact match',
  field_mismatch: 'Field mismatch',
  missing_in_a: 'Missing in ALPHA',
  missing_in_b: 'Missing in BRAVO',
  duplicate: 'Duplicate group',
  invalid: 'Invalid record',
};

function displayValue(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function RunSummary({ run }: { run: ReconciliationRunDetails['run'] }) {
  return (
    <>
      <section className="run-summary-grid" aria-label="Reconciliation run summary">
        <article className="run-stat-card">
          <span className="run-stat-label">Total results</span>
          <strong>{formatCount(run.resultCount)}</strong>
          <span className="run-stat-note">Across the full run</span>
        </article>
        <article className="run-stat-card exception-stat">
          <span className="run-stat-label">Total exceptions</span>
          <strong>{formatCount(run.exceptionCount)}</strong>
          <span className="run-stat-note">Across the full run</span>
        </article>
        <article className="run-stat-card run-time-stat">
          <span className="run-stat-label">Started</span>
          <strong>
            <time dateTime={run.startedAt}>{formatTimestamp(run.startedAt)}</time>
          </strong>
          <span className="run-stat-note">
            {run.completedAt ? (
              <>
                Completed <time dateTime={run.completedAt}>{formatTimestamp(run.completedAt)}</time>
              </>
            ) : (
              'Completion time not available'
            )}
          </span>
        </article>
      </section>

      <section className="data-panel run-batches-panel" aria-labelledby="run-batches-heading">
        <div className="panel-heading">
          <div>
            <h2 id="run-batches-heading">Source batches</h2>
            <p>Input files used for this reconciliation</p>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <div className="run-batch-grid">
          {([run.batchA, run.batchB] as const).map((batch, index) => {
            const source = index === 0 ? 'ALPHA' : 'BRAVO';
            return (
              <article className="run-batch-card" key={batch.id}>
                <span className={`source-badge source-${source.toLowerCase()}`}>{source}</span>
                <code title={batch.id}>{batch.id}</code>
                <p title={batch.originalFilename}>{batch.originalFilename}</p>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

function TradeCard({ trade }: { trade: ReconciliationResult['trades'][number] }) {
  return (
    <article className="trade-card">
      <div className="trade-card-heading">
        <span>Row {formatCount(trade.rowNumber)}</span>
        <span className={`validation-label validation-${trade.validationStatus}`}>
          {trade.validationStatus === 'valid' ? 'Valid' : 'Invalid'}
        </span>
      </div>
      <dl className="trade-fields">
        <div className="trade-field trade-field-wide">
          <dt>Source trade ID</dt>
          <dd title={trade.sourceTradeId ?? undefined}>{displayValue(trade.sourceTradeId)}</dd>
        </div>
        <div className="trade-field trade-field-wide">
          <dt>Instrument</dt>
          <dd title={trade.instrument ?? undefined}>{displayValue(trade.instrument)}</dd>
        </div>
        <div>
          <dt>Trade date</dt>
          <dd>{displayValue(trade.tradeDate)}</dd>
        </div>
        <div>
          <dt>Side</dt>
          <dd>{displayValue(trade.side)}</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>{displayValue(trade.quantity)}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{displayValue(trade.price)}</dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{displayValue(trade.currency)}</dd>
        </div>
      </dl>
      {trade.validationErrors.length > 0 ? (
        <ul className="validation-errors" aria-label="Trade validation errors">
          {trade.validationErrors.map((error, index) => (
            <li key={`${error}-${index}`}>{error}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function TradeGroup({
  source,
  trades,
}: {
  source: 'A' | 'B';
  trades: ReconciliationResult['trades'];
}) {
  const label = source === 'A' ? 'ALPHA' : 'BRAVO';
  return (
    <section
      className={`trade-group trade-group-${source.toLowerCase()}`}
      aria-label={`${label} linked trades`}
    >
      <h4>
        {label}{' '}
        <span>
          {formatCount(trades.length)} {trades.length === 1 ? 'record' : 'records'}
        </span>
      </h4>
      {trades.length > 0 ? (
        <div className="trade-card-list">
          {trades.map((trade) => (
            <TradeCard key={trade.id} trade={trade} />
          ))}
        </div>
      ) : (
        <p className="missing-counterpart">No linked trade from this source.</p>
      )}
    </section>
  );
}

function ResultCard({ result }: { result: ReconciliationResult }) {
  const tradesA = result.trades.filter((trade) => trade.sourceSide === 'A');
  const tradesB = result.trades.filter((trade) => trade.sourceSide === 'B');

  return (
    <article className={`result-card result-${result.outcome}`}>
      <div className="result-heading">
        <div className="result-title-group">
          <span className={`outcome-badge outcome-${result.outcome}`}>
            <span className="outcome-mark" aria-hidden="true" />
            {outcomeLabels[result.outcome]}
          </span>
          <code className="result-id" title={result.id}>
            Result {result.id}
          </code>
        </div>
        <time dateTime={result.createdAt}>{formatTimestamp(result.createdAt)}</time>
      </div>

      {result.details.differences?.length ? (
        <div className="difference-list" aria-label="Field differences">
          <h4>Fields that differ</h4>
          {result.details.differences.map((difference) => (
            <div className="difference-row" key={difference.field}>
              <strong>{difference.field}</strong>
              <span>
                <b>ALPHA</b>
                <code>{difference.valueA}</code>
              </span>
              <span>
                <b>BRAVO</b>
                <code>{difference.valueB}</code>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {result.details.duplicateReasons?.length ? (
        <div className="result-detail-note">
          <strong>Duplicate indicators:</strong>{' '}
          {result.details.duplicateReasons.join(', ').replaceAll('_', ' ')}
        </div>
      ) : null}
      {result.details.validationErrors?.length ? (
        <ul className="result-validation-errors" aria-label="Result validation errors">
          {result.details.validationErrors.map((error, index) => (
            <li key={`${error}-${index}`}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="linked-trades-grid">
        <TradeGroup source="A" trades={tradesA} />
        <TradeGroup source="B" trades={tradesB} />
      </div>

      {result.exception ? (
        <div className="result-exception-reference">
          <span>Exception</span>
          <code title={result.exception.id}>{result.exception.id}</code>
          <StatusBadge status={result.exception.status} />
        </div>
      ) : (
        <p className="no-exception-note">No exception was created for this result.</p>
      )}
    </article>
  );
}

function RunDetailsPage({ runId }: { runId: string }) {
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadState({ status: 'loading' });

    apiRequest<ApiDataResponse<ReconciliationRunDetails>>(
      `/api/reconciliation-runs/${encodeURIComponent(runId)}`,
      {
        query: { limit: PAGE_SIZE, offset },
        signal: controller.signal,
      },
    )
      .then((response) => {
        if (current) setLoadState({ status: 'loaded', data: response.data });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load reconciliation run.',
        });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [runId, offset, reloadKey]);

  if (loadState.status === 'loading') return <LoadingState label="Loading reconciliation run…" />;
  if (loadState.status === 'error') {
    return (
      <ErrorState message={loadState.message} onRetry={() => setReloadKey((key) => key + 1)} />
    );
  }

  const { run, results, pagination } = loadState.data;
  return (
    <div className="run-details-page">
      <div className="run-id-line">
        <span>RUN ID</span>
        <code title={run.id}>{run.id}</code>
        <a className="text-link" href="#/exceptions">
          View exceptions <span aria-hidden="true">→</span>
        </a>
      </div>
      <RunSummary run={run} />

      <section
        className="data-panel results-panel"
        aria-labelledby="results-heading"
        aria-busy={false}
      >
        <div className="panel-heading results-panel-heading">
          <div>
            <h2 id="results-heading">Reconciliation results</h2>
            <p>
              Showing {formatCount(results.length)} of {formatCount(run.resultCount)} results for
              this run.
            </p>
          </div>
          <span className="rules-version">Rules {run.rulesVersion}</span>
        </div>
        <p className="outcome-filter-note" role="note">
          Results are paginated by the API. Outcome filtering is not available on this endpoint.
        </p>
        {results.length === 0 ? (
          <EmptyState
            title={run.resultCount === 0 ? 'No results in this run' : 'No results on this page'}
            message={
              run.resultCount === 0
                ? 'This reconciliation run did not produce any result records.'
                : 'There are no results at this page offset. Return to the previous page to continue browsing.'
            }
          />
        ) : (
          <div className="result-list">
            {results.map((result) => (
              <ResultCard key={result.id} result={result} />
            ))}
          </div>
        )}
        <Pagination pagination={pagination} onOffsetChange={setOffset} />
      </section>
    </div>
  );
}

export default RunDetailsPage;
