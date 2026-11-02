import type { Pool, PoolClient } from 'pg';
import type { ExceptionStatus } from './domain.js';

export interface ExceptionRow {
  id: string;
  status: ExceptionStatus;
}

export interface UpdatedExceptionRow {
  id: string;
  status: ExceptionStatus;
  resolutionReason: string | null;
  resolvedAt: string | null;
}

export interface ExceptionAuditEventRow {
  id: string;
  eventType: string;
  actor: string;
  reason: string;
  details: { previousStatus: ExceptionStatus; newStatus: ExceptionStatus };
  createdAt: string;
}

export interface ExceptionAuditEventPageRow {
  exceptionExists: boolean;
  total: number;
  items: Array<{
    id: string;
    eventType: string;
    actor: string;
    reason: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export async function lockException(
  client: PoolClient,
  exceptionId: string,
): Promise<ExceptionRow | null> {
  const result = await client.query<ExceptionRow>(
    `SELECT id, status
     FROM exceptions
     WHERE id = $1::uuid
     FOR UPDATE`,
    [exceptionId],
  );
  return result.rows[0] ?? null;
}

export async function updateExceptionStatus(
  client: PoolClient,
  exceptionId: string,
  status: 'resolved' | 'open',
  reason: string,
): Promise<UpdatedExceptionRow> {
  const result = await client.query<UpdatedExceptionRow>(
    `UPDATE exceptions
     SET status = $2,
         resolution_reason = CASE WHEN $2 = 'resolved' THEN $3 ELSE NULL END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END
     WHERE id = $1::uuid
     RETURNING id, status, resolution_reason AS "resolutionReason",
               resolved_at AS "resolvedAt"`,
    [exceptionId, status, reason],
  );
  if (!result.rows[0]) throw new Error('Locked exception disappeared during its update.');
  return result.rows[0];
}

export async function insertExceptionAuditEvent(
  client: PoolClient,
  exceptionId: string,
  eventType: 'exception_resolved' | 'exception_reopened',
  reason: string,
  details: { previousStatus: ExceptionStatus; newStatus: ExceptionStatus },
): Promise<ExceptionAuditEventRow> {
  const result = await client.query<ExceptionAuditEventRow>(
    `INSERT INTO audit_events (exception_id, event_type, actor, reason, details)
     VALUES ($1::uuid, $2, 'anonymous-operator', $3, $4::jsonb)
     RETURNING id, event_type AS "eventType", actor, reason, details,
               created_at AS "createdAt"`,
    [exceptionId, eventType, reason, JSON.stringify(details)],
  );
  const event = result.rows[0];
  if (!event) throw new Error('Audit event insert returned no row.');
  return event;
}

export async function getExceptionDetails(pool: Pool, exceptionId: string) {
  const result = await pool.query(
    `SELECT exception.id, exception.status,
            exception.resolution_reason AS "resolutionReason",
            exception.created_at AS "createdAt", exception.resolved_at AS "resolvedAt",
            result.outcome, result.details,
            jsonb_build_object(
              'id', run.id, 'status', run.status, 'rulesVersion', run.rules_version,
              'startedAt', run.started_at, 'completedAt', run.completed_at
            ) AS run,
            jsonb_build_object(
              'id', batch_a.id, 'sourceSystem', batch_a.source_system,
              'originalFilename', batch_a.original_filename
            ) AS "batchA",
            jsonb_build_object(
              'id', batch_b.id, 'sourceSystem', batch_b.source_system,
              'originalFilename', batch_b.original_filename
            ) AS "batchB",
            COALESCE(trade_data.trades, '[]'::jsonb) AS trades
     FROM exceptions exception
     JOIN reconciliation_results result
       ON result.id = exception.reconciliation_result_id
     JOIN reconciliation_runs run
       ON run.id = result.reconciliation_run_id
     JOIN import_batches batch_a ON batch_a.id = run.batch_a_id
     JOIN import_batches batch_b ON batch_b.id = run.batch_b_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'sourceSide', link.source_side,
           'id', trade.id,
           'rowNumber', trade.row_number,
           'sourceTradeId', trade.source_trade_id,
           'tradeDate', trade.trade_date::text,
           'instrument', trade.instrument,
           'side', trade.side,
           'currency', trade.currency,
           'quantity', trade.quantity::text,
           'price', trade.price::text,
           'validationStatus', trade.validation_status,
           'validationErrors', trade.validation_errors,
           'rawRecord', CASE WHEN trade.validation_status = 'invalid'
                             THEN trade.raw_record ELSE NULL END
         ) ORDER BY link.source_side, trade.row_number, trade.id
       ) AS trades
       FROM reconciliation_result_trades link
       JOIN imported_trades trade ON trade.id = link.imported_trade_id
       WHERE link.reconciliation_result_id = result.id
     ) trade_data ON true
     WHERE exception.id = $1::uuid`,
    [exceptionId],
  );
  return result.rows[0] ?? null;
}

export async function listExceptionAuditEvents(
  pool: Pool,
  exceptionId: string,
  pagination: { limit: number; offset: number },
): Promise<ExceptionAuditEventPageRow> {
  const result = await pool.query<ExceptionAuditEventPageRow>(
    `SELECT EXISTS (
              SELECT 1 FROM exceptions WHERE id = $1::uuid
            ) AS "exceptionExists",
            (SELECT count(*)::int FROM audit_events WHERE exception_id = $1::uuid) AS total,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', event_page.id,
                  'eventType', event_page.event_type,
                  'actor', event_page.actor,
                  'reason', event_page.reason,
                  'details', event_page.details,
                  'createdAt', event_page.created_at
                ) ORDER BY event_page.created_at, event_page.id
              )
              FROM (
                SELECT id, event_type, actor, reason, details, created_at
                FROM audit_events
                WHERE exception_id = $1::uuid
                ORDER BY created_at, id
                LIMIT $2 OFFSET $3
              ) event_page
            ), '[]'::jsonb) AS items`,
    [exceptionId, pagination.limit, pagination.offset],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Audit event query returned no page metadata.');
  return row;
}
