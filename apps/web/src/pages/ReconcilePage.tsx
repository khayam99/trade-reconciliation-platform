import { useEffect, useMemo, useState } from 'react';
import { apiRequest, ApiClientError } from '../api/client';
import type {
  ApiDataResponse,
  ApiListResponse,
  BatchSource,
  ImportBatch,
  StartReconciliationRequest,
  StartReconciliationResponse,
} from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/AsyncState';
import { StatusBadge } from '../components/StatusBadge';
import { formatCount, formatTimestamp } from '../utils/formatters';
import { partitionReconciliationBatches } from './reconcileEligibility';

const PAGE_SIZE = 100;
const MAX_OFFSET = 10_000;

interface EligibleBatches {
  ALPHA: ImportBatch[];
  BRAVO: ImportBatch[];
}

type BatchLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded';
      batches: EligibleBatches;
      excludedBatches: Record<BatchSource, number>;
      truncated: boolean;
    };

interface SubmissionError {
  message: string;
  status?: number;
}

async function loadCompletedBatches(source: BatchSource, signal: AbortSignal) {
  const batches: ImportBatch[] = [];
  let offset = 0;
  let total = 0;
  let fetchedCount = 0;
  let excludedCount = 0;

  do {
    const page = await apiRequest<ApiListResponse<ImportBatch>>('/api/import-batches', {
      query: { source, status: 'completed', limit: PAGE_SIZE, offset },
      signal,
    });
    const partition = partitionReconciliationBatches(page.data);
    batches.push(...partition.eligible);
    excludedCount += partition.excludedCount;
    fetchedCount += page.data.length;
    total = page.pagination.total;
    offset += page.pagination.limit;
  } while (offset <= MAX_OFFSET && offset < total);

  return { batches, excludedCount, truncated: fetchedCount < total };
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load completed batches.';
}

function submissionError(error: unknown): SubmissionError {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return {
        status: error.status,
        message:
          'One of the selected batches could not be found. Refresh the batch list and try again.',
      };
    }
    if (error.status === 409) {
      return {
        status: error.status,
        message:
          'These batches are no longer eligible for reconciliation. Refresh the list and choose completed batches again.',
      };
    }
    return { status: error.status, message: error.message };
  }
  return {
    message: error instanceof Error ? error.message : 'Unable to start reconciliation. Try again.',
  };
}

function BatchSelector({
  source,
  batches,
  selectedId,
  onSelect,
  disabled,
}: {
  source: BatchSource;
  batches: ImportBatch[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  const selectedBatch = batches.find((batch) => batch.id === selectedId);
  const sourceName = source === 'ALPHA' ? 'System Alpha' : 'System Bravo';

  return (
    <section
      className={`source-card source-card-${source.toLowerCase()}`}
      aria-labelledby={`${source}-heading`}
    >
      <div className="source-card-heading">
        <span className={`source-badge source-${source.toLowerCase()}`}>{source}</span>
        <div>
          <h2 id={`${source}-heading`}>{sourceName}</h2>
          <p>Completed source batches</p>
        </div>
      </div>
      {batches.length === 0 ? (
        <p className="source-empty">No completed {source} batches are available.</p>
      ) : (
        <label className="batch-select-label" htmlFor={`${source}-batch-select`}>
          <span>Select a batch</span>
          <select
            id={`${source}-batch-select`}
            value={selectedId}
            disabled={disabled}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">Choose a completed batch</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.id} · {formatCount(batch.totalRows)} rows
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedBatch ? (
        <div className="selected-batch" aria-live="polite">
          <div className="selected-batch-topline">
            <span className="selected-label">Selected batch</span>
            <StatusBadge status={selectedBatch.status} />
          </div>
          <code className="selected-batch-id" title={selectedBatch.id}>
            {selectedBatch.id}
          </code>
          <dl className="batch-facts">
            <div>
              <dt>Source</dt>
              <dd>{selectedBatch.sourceSystem}</dd>
            </div>
            <div>
              <dt>Rows</dt>
              <dd>{formatCount(selectedBatch.totalRows)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                <time dateTime={selectedBatch.createdAt}>
                  {formatTimestamp(selectedBatch.createdAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function ReconcilePage() {
  const [loadState, setLoadState] = useState<BatchLoadState>({ status: 'loading' });
  const [selectedAlphaId, setSelectedAlphaId] = useState('');
  const [selectedBravoId, setSelectedBravoId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [submitError, setSubmitError] = useState<SubmissionError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadState({ status: 'loading' });

    Promise.all([
      loadCompletedBatches('ALPHA', controller.signal),
      loadCompletedBatches('BRAVO', controller.signal),
    ])
      .then(([alpha, bravo]) => {
        if (!current) return;
        setLoadState({
          status: 'loaded',
          batches: { ALPHA: alpha.batches, BRAVO: bravo.batches },
          excludedBatches: {
            ALPHA: alpha.excludedCount,
            BRAVO: bravo.excludedCount,
          },
          truncated: alpha.truncated || bravo.truncated,
        });
        setSelectedAlphaId((id) => (alpha.batches.some((batch) => batch.id === id) ? id : ''));
        setSelectedBravoId((id) => (bravo.batches.some((batch) => batch.id === id) ? id : ''));
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setLoadState({ status: 'error', message: loadErrorMessage(error) });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [reloadKey]);

  const selectedAlpha = useMemo(
    () =>
      loadState.status === 'loaded'
        ? loadState.batches.ALPHA.find((batch) => batch.id === selectedAlphaId)
        : undefined,
    [loadState, selectedAlphaId],
  );
  const selectedBravo = useMemo(
    () =>
      loadState.status === 'loaded'
        ? loadState.batches.BRAVO.find((batch) => batch.id === selectedBravoId)
        : undefined,
    [loadState, selectedBravoId],
  );
  const canSubmit = Boolean(selectedAlpha && selectedBravo && !submitting);

  const startReconciliation = async () => {
    if (!selectedAlpha || !selectedBravo || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const body: StartReconciliationRequest = {
        batchAId: selectedAlpha.id,
        batchBId: selectedBravo.id,
      };
      const response = await apiRequest<ApiDataResponse<StartReconciliationResponse>>(
        '/api/reconciliation-runs',
        { method: 'POST', body },
      );
      setSuccessMessage(
        `Reconciliation completed with ${formatCount(response.data.resultCount)} results and ${formatCount(response.data.exceptionCount)} exceptions. Opening the run…`,
      );
      setSubmitting(false);
      window.setTimeout(() => {
        window.location.hash = `#/runs/${encodeURIComponent(response.data.runId)}`;
      }, 900);
    } catch (error) {
      setSubmitError(submissionError(error));
      setSubmitting(false);
    }
  };

  if (loadState.status === 'loading') {
    return <LoadingState label="Loading completed ALPHA and BRAVO batches…" />;
  }
  if (loadState.status === 'error') {
    return (
      <ErrorState message={loadState.message} onRetry={() => setReloadKey((key) => key + 1)} />
    );
  }

  if (loadState.batches.ALPHA.length === 0 || loadState.batches.BRAVO.length === 0) {
    const missingSource = loadState.batches.ALPHA.length === 0 ? 'ALPHA' : 'BRAVO';
    const excludedCount = loadState.excludedBatches[missingSource];
    return (
      <>
        <EmptyState
          title={`No eligible completed ${missingSource} batches available`}
          message={
            loadState.truncated
              ? `No eligible completed ${missingSource} batch was found in the available page range. Completed batches without a positive valid-row count cannot be reconciled.`
              : excludedCount > 0
                ? `${formatCount(excludedCount)} completed ${missingSource} ${excludedCount === 1 ? 'batch has' : 'batches have'} no positive valid-row count. Reconciliation requires at least one valid trade in each batch.`
                : `Reconciliation requires one completed ${missingSource} batch with at least one valid trade. Add or complete an eligible batch, then return here.`
          }
          action={
            <a className="secondary-button" href="#/imports">
              View import batches
            </a>
          }
        />
        <p className="batch-limit-note" role="note">
          Completed batches with no valid trades remain visible under Import Batches, but cannot be
          reconciled.
        </p>
      </>
    );
  }

  return (
    <div className="reconcile-workflow">
      <div className="workflow-intro">
        <span className="workflow-step">01</span>
        <div>
          <h2>Choose source batches</h2>
          <p>Select one completed batch from each system to review before comparison.</p>
        </div>
      </div>

      <div className="source-selection-grid">
        <BatchSelector
          source="ALPHA"
          batches={loadState.batches.ALPHA}
          selectedId={selectedAlphaId}
          disabled={submitting}
          onSelect={(id) => {
            setSelectedAlphaId(id);
            setSubmitError(null);
          }}
        />
        <div className="source-connector" aria-hidden="true">
          ⇄
        </div>
        <BatchSelector
          source="BRAVO"
          batches={loadState.batches.BRAVO}
          selectedId={selectedBravoId}
          disabled={submitting}
          onSelect={(id) => {
            setSelectedBravoId(id);
            setSubmitError(null);
          }}
        />
      </div>

      <p className="batch-limit-note" role="note">
        Completed batches must contain at least one valid trade to be selectable. Batches with no
        valid trades remain visible under Import Batches.
        {loadState.excludedBatches.ALPHA + loadState.excludedBatches.BRAVO > 0
          ? ` ${formatCount(loadState.excludedBatches.ALPHA + loadState.excludedBatches.BRAVO)} completed batches without a positive valid-row count were excluded.`
          : ''}
      </p>

      {loadState.truncated ? (
        <p className="batch-limit-note" role="note">
          The API offset limit was reached; only batches within the available page range are
          selectable.
        </p>
      ) : null}

      <section className="review-panel" aria-labelledby="review-heading" aria-live="polite">
        <div className="workflow-intro review-heading">
          <span className="workflow-step">02</span>
          <div>
            <h2 id="review-heading">Review reconciliation</h2>
            <p>Confirm the selected source batches before starting the run.</p>
          </div>
        </div>
        <div className="review-selection-list">
          {([selectedAlpha, selectedBravo] as const).map((batch, index) => {
            const source: BatchSource = index === 0 ? 'ALPHA' : 'BRAVO';
            return (
              <div className="review-selection" key={source}>
                <span className={`source-badge source-${source.toLowerCase()}`}>{source}</span>
                {batch ? (
                  <>
                    <code title={batch.id}>{batch.id}</code>
                    <span>{formatCount(batch.totalRows)} rows</span>
                    <time dateTime={batch.createdAt}>{formatTimestamp(batch.createdAt)}</time>
                  </>
                ) : (
                  <span className="review-placeholder">Select a completed batch above</span>
                )}
              </div>
            );
          })}
        </div>
        {successMessage ? (
          <p className="submission-success" role="status" aria-live="polite">
            {successMessage}
          </p>
        ) : null}
        {submitError ? (
          <p className="submission-error" role="alert">
            {submitError.status ? <strong>Request failed ({submitError.status}). </strong> : null}
            {submitError.message}
          </p>
        ) : null}
        <div className="review-actions">
          <p>
            Starting a run compares the selected records and records its results for investigation.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={startReconciliation}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <span className="button-spinner" aria-hidden="true" /> Starting reconciliation…
              </>
            ) : (
              <>
                Start reconciliation <span aria-hidden="true">→</span>
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

export default ReconcilePage;
