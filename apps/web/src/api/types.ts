export type BatchSource = 'ALPHA' | 'BRAVO';
export type BatchStatus = 'processing' | 'completed' | 'failed';
export type RunStatus = 'processing' | 'completed' | 'failed';
export type ExceptionStatus = 'open' | 'investigating' | 'resolved' | 'ignored';
export type ReconciliationOutcome =
  'exact_match' | 'field_mismatch' | 'missing_in_a' | 'missing_in_b' | 'duplicate' | 'invalid';

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface ApiListResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface ApiDataResponse<T> {
  data: T;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface ImportBatch {
  id: string;
  sourceSystem: BatchSource;
  originalFilename: string;
  status: BatchStatus;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportValidationIssue {
  code: string;
  field: string | null;
  message: string;
}

export interface ImportValidationErrorRow {
  rowNumber: number;
  sourceTradeId: string | null;
  errors: ImportValidationIssue[];
  rawRecord: Record<string, string | null>;
}

export type ImportBatchUploadResponse = ApiDataResponse<ImportBatch>;
export type ImportBatchValidationErrorsResponse = ApiListResponse<ImportValidationErrorRow>;

export interface RunBatchReference {
  id: string;
  sourceSystem: BatchSource;
}

export interface RunBatchDetails extends RunBatchReference {
  originalFilename: string;
}

export interface ReconciliationRunSummary {
  id: string;
  status: RunStatus;
  rulesVersion: string;
  startedAt: string;
  completedAt: string | null;
  batchA: RunBatchReference;
  batchB: RunBatchReference;
  resultCount: number;
  exceptionCount: number;
}

export interface StartReconciliationRequest {
  batchAId: string;
  batchBId: string;
}

export interface StartReconciliationResponse {
  runId: string;
  resultCount: number;
  exceptionCount: number;
  status: 'completed';
}

export interface FieldDifference {
  field: 'currency' | 'quantity' | 'price';
  valueA: string;
  valueB: string;
}

export interface ReconciliationResultDetails {
  differences?: FieldDifference[];
  duplicateReasons?: Array<
    'duplicate_source_id' | 'duplicate_candidate_group' | 'identical_record'
  >;
  validationErrors?: string[];
}

export interface LinkedTrade {
  sourceSide: 'A' | 'B';
  id: string;
  rowNumber: number;
  sourceTradeId: string | null;
  tradeDate: string | null;
  instrument: string | null;
  side: 'BUY' | 'SELL' | null;
  currency: string | null;
  /** PostgreSQL NUMERIC values are returned as decimal strings, or null for invalid rows. */
  quantity: string | null;
  /** PostgreSQL NUMERIC values are returned as decimal strings, or null for invalid rows. */
  price: string | null;
  validationStatus: 'valid' | 'invalid';
  validationErrors: string[];
}

export interface ResultExceptionReference {
  id: string;
  status: ExceptionStatus;
  createdAt: string;
}

export interface ReconciliationResult {
  id: string;
  outcome: ReconciliationOutcome;
  details: ReconciliationResultDetails;
  createdAt: string;
  trades: LinkedTrade[];
  exception: ResultExceptionReference | null;
}

export interface ReconciliationRunDetails {
  run: Omit<ReconciliationRunSummary, 'batchA' | 'batchB'> & {
    batchA: RunBatchDetails;
    batchB: RunBatchDetails;
  };
  results: ReconciliationResult[];
  pagination: PaginationMeta;
}

export type ExceptionBatchReference = RunBatchReference;

export interface ReconciliationException {
  id: string;
  status: ExceptionStatus;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resultId: string;
  outcome: ReconciliationOutcome;
  details: ReconciliationResultDetails;
  runId: string;
  runStartedAt: string;
  batchA: ExceptionBatchReference;
  batchB: ExceptionBatchReference;
}

export interface ExceptionTradeDetails {
  sourceSide: 'A' | 'B';
  id: string;
  rowNumber: number;
  sourceTradeId: string | null;
  tradeDate: string | null;
  instrument: string | null;
  side: 'BUY' | 'SELL' | null;
  currency: string | null;
  /** PostgreSQL NUMERIC values are strings; invalid or missing values are null. */
  quantity: string | null;
  /** PostgreSQL NUMERIC values are strings; invalid or missing values are null. */
  price: string | null;
  validationStatus: 'valid' | 'invalid';
  validationErrors: Array<string | ImportValidationIssue>;
  rawRecord: Record<string, string | null> | null;
}

export interface ExceptionRunContext {
  id: string;
  status: RunStatus;
  rulesVersion: string;
  startedAt: string;
  completedAt: string | null;
}

export interface ExceptionBatchDetails extends ExceptionBatchReference {
  originalFilename: string;
}

export interface ExceptionDetails {
  id: string;
  status: ExceptionStatus;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  outcome: ReconciliationOutcome;
  details: ReconciliationResultDetails;
  run: ExceptionRunContext;
  batchA: ExceptionBatchDetails;
  batchB: ExceptionBatchDetails;
  trades: ExceptionTradeDetails[];
}

export interface ExceptionAuditEvent {
  id: string;
  eventType: string;
  actor: string;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ExceptionMutationRequest {
  reason: string;
}

export interface ExceptionMutationResult {
  exception: Pick<ExceptionDetails, 'id' | 'status' | 'resolutionReason' | 'resolvedAt'>;
  action: {
    id: string;
    type: 'exception_resolved' | 'exception_reopened';
    actor: string;
    reason: string;
    previousStatus: ExceptionStatus;
    newStatus: ExceptionStatus;
    createdAt: string;
  };
}

export interface HealthResponse {
  data: {
    status: 'ok';
  };
}
