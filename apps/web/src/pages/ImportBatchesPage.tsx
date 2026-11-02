import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest } from '../api/client';
import type {
  ApiListResponse,
  ImportBatchUploadResponse,
  BatchSource,
  BatchStatus,
  ImportBatch,
  ImportBatchValidationErrorsResponse,
  PaginationMeta,
} from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/AsyncState';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { formatCount, formatTimestamp } from '../utils/formatters';
import { safeImportErrorMessage, validateCsvUploadFile } from './importUploadUtils';

const PAGE_SIZE = 25;

type SourceFilter = BatchSource | 'all';
type StatusFilter = BatchStatus | 'all';

interface BatchPage {
  batches: ImportBatch[];
  pagination: PaginationMeta;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: BatchPage };

type ValidationLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: ImportBatchValidationErrorsResponse };

type UploadFeedback = { kind: 'success' | 'error'; message: string } | null;

function BatchTable({
  batches,
  onInspectErrors,
}: {
  batches: ImportBatch[];
  onInspectErrors: (batch: ImportBatch) => void;
}) {
  if (batches.length === 0) {
    return (
      <EmptyState
        title="No import batches found"
        message="Upload a CSV or change the source and status filters to find batches."
      />
    );
  }

  return (
    <div className="table-scroll" role="region" aria-label="Import batches" tabIndex={0}>
      <table className="data-table batch-table">
        <thead>
          <tr>
            <th scope="col">Batch ID</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col" className="numeric-cell">
              Rows
            </th>
            <th scope="col">Created</th>
            <th scope="col">Completed</th>
            <th scope="col">Validation</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <code className="identifier" title={batch.id}>
                  {batch.id}
                </code>
              </td>
              <td>
                <span className={`source-badge source-${batch.sourceSystem.toLowerCase()}`}>
                  {batch.sourceSystem}
                </span>
              </td>
              <td>
                <StatusBadge status={batch.status} />
              </td>
              <td className="numeric-cell">
                <span className="row-total">{formatCount(batch.totalRows)}</span>
                <span className="row-breakdown">
                  {formatCount(batch.validRows)} valid · {formatCount(batch.invalidRows)} invalid
                </span>
              </td>
              <td>
                <time dateTime={batch.createdAt}>{formatTimestamp(batch.createdAt)}</time>
              </td>
              <td>
                {batch.completedAt ? (
                  <time dateTime={batch.completedAt}>{formatTimestamp(batch.completedAt)}</time>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {batch.invalidRows > 0 ? (
                  <button
                    className="validation-link-button"
                    type="button"
                    onClick={() => onInspectErrors(batch)}
                    aria-label={`Review ${batch.invalidRows} invalid rows in batch ${batch.id}`}
                  >
                    Review {formatCount(batch.invalidRows)} rows
                  </button>
                ) : (
                  <span className="validation-none">No issues</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValidationErrorsPanel({ batch, onClose }: { batch: ImportBatch; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<ValidationLoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: 'loading' });

    apiRequest<ImportBatchValidationErrorsResponse>(
      `/api/import-batches/${encodeURIComponent(batch.id)}/errors`,
      { query: { limit: PAGE_SIZE, offset }, signal: controller.signal },
    )
      .then((data) => {
        if (current) setState({ status: 'loaded', data });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({ status: 'error', message: safeImportErrorMessage(error) });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [batch.id, offset, reloadKey]);

  return (
    <section className="data-panel validation-panel" aria-labelledby="validation-heading">
      <div className="panel-heading validation-panel-heading">
        <div>
          <h2 id="validation-heading">Validation errors</h2>
          <p>
            {batch.sourceSystem} · <code>{batch.id}</code>
          </p>
        </div>
        <button className="secondary-button validation-close" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {state.status === 'loading' ? (
        <LoadingState label="Loading validation errors…" />
      ) : state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setReloadKey((key) => key + 1)} />
      ) : state.data.pagination.total === 0 ? (
        <EmptyState title="No validation errors" message="All imported rows passed validation." />
      ) : (
        <>
          <div className="validation-rows" aria-live="polite">
            {state.data.data.map((row) => (
              <article className="validation-row-card" key={row.rowNumber}>
                <div className="validation-row-heading">
                  <h3>CSV row {formatCount(row.rowNumber)}</h3>
                  {row.sourceTradeId ? <code>{row.sourceTradeId}</code> : null}
                </div>
                <ul className="validation-issue-list">
                  {row.errors.map((issue, index) => (
                    <li key={`${issue.code}-${issue.field ?? 'row'}-${index}`}>
                      <code className="validation-issue-code">{issue.code}</code>
                      {issue.field ? (
                        <span className="validation-issue-field">{issue.field}</span>
                      ) : null}
                      <p>{issue.message}</p>
                    </li>
                  ))}
                </ul>
                <details className="validation-raw-record">
                  <summary>View original CSV row</summary>
                  <dl>
                    {Object.entries(row.rawRecord).map(([field, value]) => (
                      <div key={field}>
                        <dt>{field}</dt>
                        <dd>{value === null ? <em>Empty cell</em> : value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </article>
            ))}
          </div>
          <Pagination pagination={state.data.pagination} onOffsetChange={setOffset} />
        </>
      )}
    </section>
  );
}

function ImportBatchesPage() {
  const [source, setSource] = useState<SourceFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [uploadSource, setUploadSource] = useState<BatchSource>('ALPHA');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback>(null);
  const [uploadedBatch, setUploadedBatch] = useState<ImportBatch | null>(null);
  const [inspectionBatch, setInspectionBatch] = useState<ImportBatch | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadInFlightRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadState({ status: 'loading' });

    apiRequest<ApiListResponse<ImportBatch>>('/api/import-batches', {
      query: {
        source: source === 'all' ? undefined : source,
        status: status === 'all' ? undefined : status,
        limit: PAGE_SIZE,
        offset,
      },
      signal: controller.signal,
    })
      .then((response) => {
        if (!current) return;
        setLoadState({
          status: 'loaded',
          data: { batches: response.data, pagination: response.pagination },
        });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setLoadState({ status: 'error', message: safeImportErrorMessage(error) });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [source, status, offset, reloadKey]);

  const selectedFileError = file ? validateCsvUploadFile(file) : null;

  const changeSource = (nextSource: SourceFilter) => {
    setSource(nextSource);
    setOffset(0);
  };
  const changeStatus = (nextStatus: StatusFilter) => {
    setStatus(nextStatus);
    setOffset(0);
  };

  const submitUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (uploadInFlightRef.current) return;
    if (!file) {
      setUploadFeedback({ kind: 'error', message: 'Choose a CSV file to upload.' });
      return;
    }
    const validationMessage = validateCsvUploadFile(file);
    if (validationMessage) {
      setUploadFeedback({ kind: 'error', message: validationMessage });
      return;
    }

    const form = new FormData();
    form.append('source', uploadSource);
    form.append('file', file);
    uploadInFlightRef.current = true;
    setUploading(true);
    setUploadFeedback(null);
    setUploadedBatch(null);
    try {
      const response = await apiRequest<ImportBatchUploadResponse>('/api/import-batches', {
        method: 'POST',
        body: form,
      });
      setUploadedBatch(response.data);
      setUploadFeedback({
        kind: 'success',
        message:
          response.data.invalidRows > 0
            ? `Import completed. ${formatCount(response.data.invalidRows)} rows need validation review.`
            : 'Import completed. All rows passed validation.',
      });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSource(response.data.sourceSystem);
      setStatus('all');
      setOffset(0);
      setReloadKey((key) => key + 1);
      if (response.data.invalidRows > 0) setInspectionBatch(response.data);
    } catch (error) {
      setUploadFeedback({ kind: 'error', message: safeImportErrorMessage(error) });
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  };

  return (
    <>
      <section className="data-panel upload-panel" aria-labelledby="upload-heading">
        <div className="panel-heading">
          <div>
            <h2 id="upload-heading">Import a CSV file</h2>
            <p>Upload a synthetic trade file from ALPHA or BRAVO. Maximum file size: 5 MiB.</p>
          </div>
        </div>
        <form className="upload-form" onSubmit={submitUpload} aria-busy={uploading}>
          <div className="upload-fields">
            <label className="upload-field">
              <span>Source system</span>
              <select
                value={uploadSource}
                onChange={(event) => setUploadSource(event.target.value as BatchSource)}
                disabled={uploading}
              >
                <option value="ALPHA">ALPHA</option>
                <option value="BRAVO">BRAVO</option>
              </select>
            </label>
            <label className="upload-field upload-file-field">
              <span>CSV file</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,application/csv,application/vnd.ms-excel"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                  setUploadedBatch(null);
                  setUploadFeedback(null);
                }}
                disabled={uploading}
                aria-describedby="upload-file-help upload-file-error"
              />
            </label>
            <button
              className="primary-button upload-submit"
              type="submit"
              disabled={uploading || !file || Boolean(selectedFileError)}
            >
              {uploading ? <span className="button-spinner" aria-hidden="true" /> : null}
              {uploading ? 'Uploading…' : 'Upload CSV'}
            </button>
          </div>
          <div className="upload-file-summary" id="upload-file-help" aria-live="polite">
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span>{formatFileSize(file.size)}</span>
              </>
            ) : (
              <span>No file selected</span>
            )}
          </div>
          {selectedFileError ? (
            <p className="upload-inline-error" id="upload-file-error" role="alert">
              {selectedFileError}
            </p>
          ) : (
            <span className="sr-only" id="upload-file-error">
              No file validation errors.
            </span>
          )}
          {uploading ? (
            <p className="upload-pending" role="status" aria-live="polite">
              Uploading and validating the CSV. Keep this page open until it finishes.
            </p>
          ) : null}
          {uploadFeedback ? (
            <p
              className={`upload-feedback upload-feedback-${uploadFeedback.kind}`}
              role={uploadFeedback.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {uploadFeedback.message}
            </p>
          ) : null}
          {uploadedBatch ? (
            <div className="upload-result" aria-label="Import summary">
              <h3>Import summary</h3>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <span
                      className={`source-badge source-${uploadedBatch.sourceSystem.toLowerCase()}`}
                    >
                      {uploadedBatch.sourceSystem}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Batch ID</dt>
                  <dd>
                    <code className="identifier">{uploadedBatch.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge status={uploadedBatch.status} />
                  </dd>
                </div>
                <div>
                  <dt>Total rows</dt>
                  <dd>{formatCount(uploadedBatch.totalRows)}</dd>
                </div>
                <div>
                  <dt>Valid rows</dt>
                  <dd>{formatCount(uploadedBatch.validRows)}</dd>
                </div>
                <div>
                  <dt>Invalid rows</dt>
                  <dd>{formatCount(uploadedBatch.invalidRows)}</dd>
                </div>
              </dl>
              {uploadedBatch.invalidRows > 0 ? (
                <button
                  className="validation-link-button"
                  type="button"
                  onClick={() => setInspectionBatch(uploadedBatch)}
                >
                  Inspect validation errors
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      </section>

      <section
        className="data-panel"
        aria-labelledby="batch-list-heading"
        aria-busy={loadState.status === 'loading'}
      >
        <div className="panel-heading batch-panel-heading">
          <div>
            <h2 id="batch-list-heading">Import batches</h2>
            <p>Batch records loaded from the reconciliation API</p>
          </div>
          <div className="filter-controls">
            <label>
              <span>Source</span>
              <select
                value={source}
                onChange={(event) => changeSource(event.target.value as SourceFilter)}
              >
                <option value="all">All sources</option>
                <option value="ALPHA">ALPHA</option>
                <option value="BRAVO">BRAVO</option>
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => changeStatus(event.target.value as StatusFilter)}
              >
                <option value="all">All statuses</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </label>
          </div>
        </div>

        {loadState.status === 'loading' ? (
          <LoadingState label="Loading import batches…" />
        ) : loadState.status === 'error' ? (
          <ErrorState message={loadState.message} onRetry={() => setReloadKey((key) => key + 1)} />
        ) : (
          <>
            <BatchTable
              batches={loadState.data.batches}
              onInspectErrors={(batch) => setInspectionBatch(batch)}
            />
            <Pagination pagination={loadState.data.pagination} onOffsetChange={setOffset} />
          </>
        )}
      </section>

      {inspectionBatch ? (
        <ValidationErrorsPanel
          key={inspectionBatch.id}
          batch={inspectionBatch}
          onClose={() => setInspectionBatch(null)}
        />
      ) : null}
    </>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export default ImportBatchesPage;
