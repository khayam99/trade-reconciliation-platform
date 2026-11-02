import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest } from '../api/client';
import {
  getExceptionAuditEvents,
  getExceptionDetails,
  reopenException,
  resolveException,
} from '../api/exceptions';
import type {
  ApiListResponse,
  ExceptionAuditEvent,
  ExceptionDetails as ExceptionInspection,
  ExceptionStatus,
  PaginationMeta,
  ReconciliationException,
  ReconciliationOutcome,
} from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/AsyncState';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { formatCount, formatTimestamp } from '../utils/formatters';
import {
  auditStatusChange,
  availableExceptionAction,
  displayValidationError,
  exceptionMutationErrorMessage,
  validateExceptionReason,
} from './exceptionManagement';

const PAGE_SIZE = 25;

type StatusFilter = ExceptionStatus | 'all';
type OutcomeFilter = ReconciliationOutcome | 'all';

interface ExceptionPageData {
  exceptions: ReconciliationException[];
  pagination: PaginationMeta;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: ExceptionPageData };

type DataState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: T };

const outcomeLabels: Record<ReconciliationOutcome, string> = {
  exact_match: 'Exact match',
  field_mismatch: 'Field mismatch',
  missing_in_a: 'Missing in ALPHA',
  missing_in_b: 'Missing in BRAVO',
  duplicate: 'Duplicate group',
  invalid: 'Invalid record',
};

function formatReason(reason: string): string {
  return reason.replaceAll('_', ' ');
}

function valueOrDash(value: string | null): string {
  return value === null || value.length === 0 ? '—' : value;
}

function auditActionLabel(eventType: string): string {
  const labels: Record<string, string> = {
    exception_created: 'Exception created',
    exception_resolved: 'Exception resolved',
    exception_reopened: 'Exception reopened',
  };
  return labels[eventType] ?? formatReason(eventType);
}

function DifferenceDetails({ exception }: { exception: ExceptionInspection }) {
  const { details } = exception;
  const hasDetails = Boolean(
    details.differences?.length ||
    details.duplicateReasons?.length ||
    details.validationErrors?.length,
  );

  return (
    <>
      {details.differences?.length ? (
        <section className="exception-detail-section" aria-label="Field differences">
          <h4>Field differences</h4>
          <div className="exception-difference-list">
            {details.differences.map((difference) => (
              <div className="exception-difference" key={difference.field}>
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
        </section>
      ) : null}
      {details.duplicateReasons?.length ? (
        <section className="exception-detail-section">
          <h4>Duplicate indicators</h4>
          <ul className="exception-reason-list">
            {details.duplicateReasons.map((reason) => (
              <li key={reason}>{formatReason(reason)}</li>
            ))}
          </ul>
          <p className="exception-context-note">
            This exception represents a group. All linked records are listed below.
          </p>
        </section>
      ) : null}
      {details.validationErrors?.length ? (
        <section className="exception-detail-section">
          <h4>Reconciliation validation details</h4>
          <ul className="exception-reason-list validation-reason-list">
            {details.validationErrors.map((message, index) => (
              <li key={`${message}-${index}`}>{message}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {!hasDetails ? (
        <p className="exception-context-note">No additional discrepancy details were recorded.</p>
      ) : null}
    </>
  );
}

function LinkedTrades({ exception }: { exception: ExceptionInspection }) {
  if (exception.trades.length === 0) {
    return (
      <EmptyState
        title="No linked trades"
        message="This result does not have linked trade records to display."
      />
    );
  }

  return (
    <section className="exception-detail-section">
      <h4>Linked trades ({formatCount(exception.trades.length)})</h4>
      <div className="exception-trades-list">
        {exception.trades.map((trade) => (
          <article className="exception-trade-card" key={trade.id}>
            <header>
              <strong>
                {trade.sourceSide === 'A'
                  ? exception.batchA.sourceSystem
                  : exception.batchB.sourceSystem}
              </strong>
              <span>Row {trade.rowNumber}</span>
              <code>{valueOrDash(trade.sourceTradeId)}</code>
              {trade.validationStatus === 'invalid' ? (
                <span className="outcome-badge outcome-invalid">Invalid row</span>
              ) : null}
            </header>
            <dl className="exception-trade-fields">
              <div>
                <dt>Instrument</dt>
                <dd>{valueOrDash(trade.instrument)}</dd>
              </div>
              <div>
                <dt>Trade date</dt>
                <dd>{valueOrDash(trade.tradeDate)}</dd>
              </div>
              <div>
                <dt>Side</dt>
                <dd>{valueOrDash(trade.side)}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{valueOrDash(trade.currency)}</dd>
              </div>
              <div>
                <dt>Quantity</dt>
                <dd>
                  <code>{valueOrDash(trade.quantity)}</code>
                </dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>
                  <code>{valueOrDash(trade.price)}</code>
                </dd>
              </div>
            </dl>
            {trade.validationErrors.length ? (
              <div className="exception-trade-validation">
                <strong>Import validation issues</strong>
                <ul className="exception-reason-list validation-reason-list">
                  {trade.validationErrors.map((issue, index) => (
                    <li key={`${index}-${typeof issue === 'string' ? issue : issue.code}`}>
                      {displayValidationError(issue)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {trade.validationStatus === 'invalid' && trade.rawRecord ? (
              <details className="exception-raw-record">
                <summary>Original CSV record</summary>
                <pre>{JSON.stringify(trade.rawRecord, null, 2)}</pre>
              </details>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function AuditHistory({
  state,
  offset,
  onOffsetChange,
  onRetry,
}: {
  state: DataState<ApiListResponse<ExceptionAuditEvent>>;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onRetry: () => void;
}) {
  return (
    <section className="exception-detail-section" aria-labelledby="exception-history-heading">
      <div className="exception-history-heading">
        <h4 id="exception-history-heading">Activity history</h4>
        <small>
          <code>anonymous-operator</code> is an application-assigned label, not an authenticated
          identity.
        </small>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? (
        <LoadingState label="Loading activity history…" />
      ) : state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={onRetry} />
      ) : state.data.data.length === 0 ? (
        <EmptyState
          title="No activity yet"
          message="No audit events have been recorded for this exception."
        />
      ) : (
        <>
          <ol className="exception-timeline">
            {state.data.data.map((event) => {
              const statusChange = auditStatusChange(event.details);
              return (
                <li key={event.id}>
                  <div className="exception-timeline-marker" aria-hidden="true" />
                  <div className="exception-timeline-content">
                    <div className="exception-timeline-title">
                      <strong>{auditActionLabel(event.eventType)}</strong>
                      <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
                    </div>
                    <span className="exception-timeline-actor">{event.actor}</span>
                    {statusChange ? (
                      <span className="exception-timeline-status">{statusChange}</span>
                    ) : null}
                    {event.reason ? <p>{event.reason}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <Pagination pagination={state.data.pagination} onOffsetChange={onOffsetChange} />
        </>
      )}
      {state.status === 'loaded' && offset > 0 && state.data.data.length === 0 ? (
        <Pagination pagination={state.data.pagination} onOffsetChange={onOffsetChange} />
      ) : null}
    </section>
  );
}

function ExceptionActionForm({
  exceptionId,
  status,
  pending,
  error,
  onSubmit,
}: {
  exceptionId: string;
  status: ExceptionStatus;
  pending: boolean;
  error: string | null;
  onSubmit: (action: 'resolve' | 'reopen', reason: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const action = availableExceptionAction(status);
  if (!action) return null;

  const label = action === 'resolve' ? 'Resolve exception' : 'Reopen exception';
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateExceptionReason(reason);
    if (validation.error || !validation.reason) {
      setValidationError(validation.error ?? 'Enter a reason before continuing.');
      return;
    }
    setValidationError(null);
    const succeeded = await onSubmit(action, validation.reason);
    if (succeeded) {
      setReason('');
      setOpen(false);
    }
  };

  return (
    <section className="exception-action-section">
      {!open ? (
        <button className="secondary-button" type="button" onClick={() => setOpen(true)}>
          {label}
        </button>
      ) : (
        <form className="exception-action-form" onSubmit={submit}>
          <label htmlFor={`exception-reason-${exceptionId}`}>
            {action === 'resolve' ? 'Resolution reason' : 'Reason for reopening'}
          </label>
          <textarea
            id={`exception-reason-${exceptionId}`}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (validationError) setValidationError(null);
            }}
            rows={3}
            required
            aria-describedby="exception-reason-help"
            disabled={pending}
          />
          <div className="exception-reason-meta" id="exception-reason-help">
            <span>{reason.trim().length}/1,000 characters after trimming</span>
            <span>Whitespace around the reason is removed before saving.</span>
          </div>
          {validationError || error ? (
            <p className="exception-action-error" role="alert">
              {validationError ?? error}
            </p>
          ) : null}
          <div className="exception-action-buttons">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? 'Saving…' : label}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ExceptionInspector({
  exception,
  expanded,
  onExpandedChange,
  onMutationSuccess,
}: {
  exception: ReconciliationException;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onMutationSuccess: () => void;
}) {
  const [detailState, setDetailState] = useState<DataState<ExceptionInspection>>({
    status: 'idle',
  });
  const [auditState, setAuditState] = useState<DataState<ApiListResponse<ExceptionAuditEvent>>>({
    status: 'idle',
  });
  const [auditOffset, setAuditOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const detailCache = useRef<ExceptionInspection | null>(null);
  const auditCache = useRef(new Map<number, ApiListResponse<ExceptionAuditEvent>>());

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let current = true;

    if (!detailCache.current) {
      setDetailState({ status: 'loading' });
      getExceptionDetails(exception.id, controller.signal)
        .then((response) => {
          if (!current) return;
          detailCache.current = response.data;
          setDetailState({ status: 'loaded', data: response.data });
        })
        .catch((error: unknown) => {
          if (!current || controller.signal.aborted) return;
          setDetailState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load exception details.',
          });
        });
    }

    if (!auditCache.current.has(auditOffset)) {
      setAuditState({ status: 'loading' });
      getExceptionAuditEvents(
        exception.id,
        { limit: PAGE_SIZE, offset: auditOffset },
        controller.signal,
      )
        .then((response) => {
          if (!current) return;
          auditCache.current.set(auditOffset, response);
          setAuditState({ status: 'loaded', data: response });
        })
        .catch((error: unknown) => {
          if (!current || controller.signal.aborted) return;
          setAuditState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load audit history.',
          });
        });
    } else {
      const cached = auditCache.current.get(auditOffset);
      if (cached) setAuditState({ status: 'loaded', data: cached });
    }

    return () => {
      current = false;
      controller.abort();
    };
  }, [expanded, exception.id, auditOffset, reloadKey]);

  const retry = () => {
    detailCache.current = null;
    auditCache.current.clear();
    setDetailState({ status: 'idle' });
    setAuditState({ status: 'idle' });
    setReloadKey((key) => key + 1);
  };

  const submitAction = async (action: 'resolve' | 'reopen', reason: string): Promise<boolean> => {
    setMutationPending(true);
    setMutationError(null);
    try {
      if (action === 'resolve') await resolveException(exception.id, { reason });
      else await reopenException(exception.id, { reason });
      detailCache.current = null;
      auditCache.current.clear();
      setDetailState({ status: 'idle' });
      setAuditState({ status: 'idle' });
      setAuditOffset(0);
      setReloadKey((key) => key + 1);
      onMutationSuccess();
      return true;
    } catch (error) {
      setMutationError(exceptionMutationErrorMessage(error));
      return false;
    } finally {
      setMutationPending(false);
    }
  };

  const expandedState =
    detailState.status === 'loaded' ? detailState.data.status : exception.status;

  return (
    <details
      className="exception-details"
      open={expanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
    >
      <summary>Inspect and manage</summary>
      <div className="exception-inspection">
        {detailState.status === 'idle' || detailState.status === 'loading' ? (
          <LoadingState label="Loading exception details…" />
        ) : detailState.status === 'error' ? (
          <ErrorState message={detailState.message} onRetry={retry} />
        ) : (
          <>
            <section className="exception-detail-section">
              <div className="exception-inspection-heading">
                <div>
                  <h3>{outcomeLabels[detailState.data.outcome]}</h3>
                  <p>
                    Exception <code>{detailState.data.id}</code>
                  </p>
                </div>
                <StatusBadge status={detailState.data.status} />
              </div>
              <div className="exception-run-card">
                <a
                  className="run-link"
                  href={`#/runs/${encodeURIComponent(detailState.data.run.id)}`}
                >
                  Run {detailState.data.run.id}
                </a>
                <span>
                  {detailState.data.batchA.sourceSystem} ·{' '}
                  {detailState.data.batchA.originalFilename}
                </span>
                <span>
                  {detailState.data.batchB.sourceSystem} ·{' '}
                  {detailState.data.batchB.originalFilename}
                </span>
                <small>Started {formatTimestamp(detailState.data.run.startedAt)}</small>
              </div>
            </section>
            {detailState.data.resolutionReason || detailState.data.resolvedAt ? (
              <section className="exception-detail-section">
                <h4>Current resolution</h4>
                <p className="resolution-record-text">
                  {detailState.data.resolutionReason ?? 'No current resolution reason.'}
                  {detailState.data.resolvedAt ? (
                    <>
                      {' '}
                      · Resolved{' '}
                      <time dateTime={detailState.data.resolvedAt}>
                        {formatTimestamp(detailState.data.resolvedAt)}
                      </time>
                    </>
                  ) : null}
                </p>
              </section>
            ) : null}
            <DifferenceDetails exception={detailState.data} />
            <LinkedTrades exception={detailState.data} />
            <ExceptionActionForm
              exceptionId={detailState.data.id}
              status={expandedState}
              pending={mutationPending}
              error={mutationError}
              onSubmit={submitAction}
            />
            <AuditHistory
              state={auditState}
              offset={auditOffset}
              onOffsetChange={setAuditOffset}
              onRetry={retry}
            />
          </>
        )}
      </div>
    </details>
  );
}

function ExceptionTable({
  exceptions,
  onMutationSuccess,
}: {
  exceptions: ReconciliationException[];
  onMutationSuccess: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (exceptions.length === 0) {
    return (
      <EmptyState
        title="No exceptions found"
        message="No exceptions match the selected filters. Try another status or outcome, or return after a reconciliation run."
      />
    );
  }

  return (
    <div className="table-scroll" role="region" aria-label="Reconciliation exceptions" tabIndex={0}>
      <table className="data-table exception-table">
        <thead>
          <tr>
            <th scope="col">Exception</th>
            <th scope="col">Status</th>
            <th scope="col">Outcome</th>
            <th scope="col">Created</th>
            <th scope="col">Run and source batches</th>
            <th scope="col">Inspection and actions</th>
          </tr>
        </thead>
        <tbody>
          {exceptions.map((exception) => (
            <tr key={exception.id}>
              <td>
                <code className="exception-id" title={exception.id}>
                  {exception.id}
                </code>
              </td>
              <td>
                <StatusBadge status={exception.status} />
              </td>
              <td>
                <span className={`outcome-badge outcome-${exception.outcome}`}>
                  <span className="outcome-mark" aria-hidden="true" />
                  {outcomeLabels[exception.outcome]}
                </span>
              </td>
              <td>
                <time dateTime={exception.createdAt}>{formatTimestamp(exception.createdAt)}</time>
              </td>
              <td>
                <div className="exception-run-context">
                  <a className="run-link" href={`#/runs/${encodeURIComponent(exception.runId)}`}>
                    <code title={exception.runId}>Run {exception.runId}</code>
                  </a>
                  <span>
                    {exception.batchA.sourceSystem}{' '}
                    <code title={exception.batchA.id}>{exception.batchA.id}</code>
                    <span aria-hidden="true"> ↔ </span>
                    {exception.batchB.sourceSystem}{' '}
                    <code title={exception.batchB.id}>{exception.batchB.id}</code>
                  </span>
                  <small>Started {formatTimestamp(exception.runStartedAt)}</small>
                </div>
              </td>
              <td>
                <ExceptionInspector
                  exception={exception}
                  expanded={expandedId === exception.id}
                  onExpandedChange={(isExpanded) => setExpandedId(isExpanded ? exception.id : null)}
                  onMutationSuccess={onMutationSuccess}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExceptionsPage() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadState({ status: 'loading' });

    apiRequest<ApiListResponse<ReconciliationException>>('/api/exceptions', {
      query: {
        status: status === 'all' ? undefined : status,
        outcome: outcome === 'all' ? undefined : outcome,
        limit: PAGE_SIZE,
        offset,
      },
      signal: controller.signal,
    })
      .then((response) => {
        if (!current) return;
        setLoadState({
          status: 'loaded',
          data: { exceptions: response.data, pagination: response.pagination },
        });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load exceptions.',
        });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [status, outcome, offset, reloadKey]);

  const changeStatus = (value: StatusFilter) => {
    setStatus(value);
    setOffset(0);
  };
  const changeOutcome = (value: OutcomeFilter) => {
    setOutcome(value);
    setOffset(0);
  };

  return (
    <>
      <div className="exception-capability-note" role="note">
        <span className="notice-icon" aria-hidden="true">
          i
        </span>
        <p>
          <strong>Investigate and resolve</strong>
          <span>Resolution reasons and audit history are recorded for each status change.</span>
        </p>
      </div>

      <section
        className="data-panel exceptions-panel"
        aria-labelledby="exceptions-heading"
        aria-busy={loadState.status === 'loading'}
      >
        <div className="panel-heading exception-panel-heading">
          <div>
            <h2 id="exceptions-heading">Reconciliation exceptions</h2>
            <p>Inspect linked records, record a resolution, or reopen resolved items.</p>
          </div>
          <div className="filter-controls">
            <label>
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => changeStatus(event.target.value as StatusFilter)}
              >
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="investigating">Investigating</option>
                <option value="resolved">Resolved</option>
                <option value="ignored">Ignored</option>
              </select>
            </label>
            <label>
              <span>Outcome</span>
              <select
                value={outcome}
                onChange={(event) => changeOutcome(event.target.value as OutcomeFilter)}
              >
                <option value="all">All outcomes</option>
                <option value="exact_match">Exact match</option>
                <option value="field_mismatch">Field mismatch</option>
                <option value="missing_in_a">Missing in ALPHA</option>
                <option value="missing_in_b">Missing in BRAVO</option>
                <option value="duplicate">Duplicate</option>
                <option value="invalid">Invalid</option>
              </select>
            </label>
          </div>
        </div>

        {loadState.status === 'loading' ? (
          <LoadingState label="Loading exceptions…" />
        ) : loadState.status === 'error' ? (
          <ErrorState message={loadState.message} onRetry={() => setReloadKey((key) => key + 1)} />
        ) : (
          <>
            <p className="exception-count-line" aria-live="polite">
              {formatCount(loadState.data.pagination.total)} matching exceptions
            </p>
            <ExceptionTable
              exceptions={loadState.data.exceptions}
              onMutationSuccess={() => setReloadKey((key) => key + 1)}
            />
            <Pagination pagination={loadState.data.pagination} onOffsetChange={setOffset} />
          </>
        )}
      </section>
    </>
  );
}

export default ExceptionsPage;
