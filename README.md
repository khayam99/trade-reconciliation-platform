# LedgerLine · Trade Reconciliation

LedgerLine is a portfolio and learning project that simulates financial operations work. It imports synthetic trade records from two source systems, validates and retains each row, compares batches using deterministic rules, and presents reconciliation results and exceptions for investigation.

LedgerLine uses synthetic data only. It does not connect to real trading systems, execute trades, or move money.

## Features

- Upload ALPHA and BRAVO CSV files and review import totals.
- Retain valid and invalid source rows, original cell values, and validation issues.
- Keep duplicate source IDs and identical records available for investigation.
- Reconcile eligible batches and identify exact matches, field mismatches, duplicate groups, missing trades, and invalid rows.
- Inspect paginated run results, linked source trades, field differences, and exceptions.
- Filter and paginate batches, runs, and exceptions using API-backed data.
- Resolve and reopen exceptions with required reasons, and inspect their append-only audit history.

An import with some or all invalid rows can complete. A batch with no valid trades remains visible in Imports, but cannot be selected for reconciliation.

## Technology and architecture

- **Web:** React, TypeScript, and Vite.
- **API:** Node.js, Express, and TypeScript, with Multer for bounded in-memory multipart uploads.
- **Database:** PostgreSQL, accessed with `pg` and parameterized SQL.
- **CSV:** `csv-parse` handles CSV structure; domain validation is implemented independently of Express and PostgreSQL.
- **Tests:** Vitest unit tests and Node.js HTTP/PostgreSQL integration tests.

The repository is an npm-workspace monorepo. The React client uses a small fetch client and hash-based routes. The Express app injects a PostgreSQL pool into route modules. Routes validate HTTP input, services coordinate use cases and transactions, repositories own SQL, and the reconciliation domain contains pure matching logic. SQL migrations in `db/migrations` define the schema and integrity constraints.

Financial amounts use PostgreSQL `numeric(24,10)`. The API returns quantities and prices as decimal strings, and reconciliation compares scaled `BigInt` values rather than JavaScript floating-point numbers.

## CSV upload formats

Choose the source when uploading. Required headers are source-specific; additional uniquely named columns are retained in the original row data.

**ALPHA**

```csv
trade_id,trade_date,instrument,side,currency,quantity,price
ALPHA-9001,2026-10-01,ACME,BUY,USD,100.0000000000,24.5000000000
```

**BRAVO**

```csv
execution_id,trade_date,symbol,direction,currency,units,unit_price
BRAVO-5001,2026-10-01,ACME,BUY,USD,100.0000000000,24.5000000000
```

The importer accepts UTF-8 CSV files up to 5 MiB, with at most 10,000 data records and a finite 64 KiB record-size limit. It rejects empty/header-only files, malformed quoting, and missing or duplicate headers. Recoverable rows with invalid values or field counts are retained as invalid records with issue codes, readable messages, and their original cell values.

Validation requires a valid ISO calendar date, a nonempty instrument, BUY or SELL, a three-letter currency, positive quantity, and nonnegative price. Decimals must fit `numeric(24,10)`, use plain decimal notation, and have no more than 10 fractional digits. Exponent notation and grouping separators are rejected. Duplicate trade IDs are allowed.

Data row numbers start at 1 and exclude the header and blank lines. Use the Import Batches page to inspect paginated validation issues for an imported batch.

## Reconciliation and exceptions

Select one completed ALPHA batch and one completed BRAVO batch that each contain at least one valid trade. The candidate grouping key is trade date, instrument, and side; it narrows possible matches but does not prove identity. The engine compares currency, quantity, and price exactly. Ambiguous candidate groups, repeated source IDs, and identical records are reported as duplicates rather than arbitrarily paired.

Results include:

- **Exact match** — the compared business values agree.
- **Field mismatch** — candidate records differ in currency, quantity, or price.
- **Missing in ALPHA / missing in BRAVO** — a valid trade has no candidate on the other side.
- **Duplicate** — records form an ambiguous or duplicate group.
- **Invalid** — an imported row failed validation; it is not used to create a missing-trade result.

Non-exact results create open exceptions and audit events. The Run Details page shows full-run counts, paginated results, linked trades, and discrepancy details. The Exceptions page supports filtering, detailed investigation, resolution, reopening, and chronological audit-history inspection. Resolution is allowed for open or investigating exceptions; reopening is allowed for resolved exceptions. Each action requires a reason, and historical events remain available after reopening. Audit events use the application-assigned `anonymous-operator` label; it is not an authenticated identity.

## API routes

The development API listens on port 3000. Successful responses use a `data` envelope; paginated list responses also include `pagination`. Errors use an `error` envelope.

- `GET /api/health` — API health.
- `GET /api/import-batches` — list/filter batches with `source`, `status`, `limit`, and `offset`.
- `POST /api/import-batches` — upload multipart form fields `source` and `file`.
- `GET /api/import-batches/:batchId/errors` — paginate validation issues with `limit` and `offset`.
- `POST /api/reconciliation-runs` — start a run with JSON `batchAId` and `batchBId`.
- `GET /api/reconciliation-runs` — list/filter runs.
- `GET /api/reconciliation-runs/:runId` — retrieve run metadata and a page of results.
- `GET /api/exceptions` — list/filter exceptions.
- `GET /api/exceptions/:exceptionId` — retrieve exception context, linked trades, and current resolution fields.
- `GET /api/exceptions/:exceptionId/audit-events` — retrieve that exception's chronological, paginated audit history (`limit` and `offset`).
- `POST /api/exceptions/:exceptionId/resolve` — resolve an open or investigating exception with a JSON `reason`.
- `POST /api/exceptions/:exceptionId/reopen` — reopen a resolved exception with a JSON `reason`; previous audit events are preserved.

List pagination defaults to 25 rows, allows up to 100 rows per page, and caps the offset at 10,000.

## Requirements and PostgreSQL setup

- Node.js 24 and npm 11 (see `.nvmrc`).
- PostgreSQL 16 or later for database-backed features.
- Native PostgreSQL on Windows is the documented local setup. Docker is optional; this repository does not include a Docker Compose configuration.

If PostgreSQL is not already installed, use the installer from the [official PostgreSQL Windows download page](https://www.postgresql.org/download/windows/). For a new local setup, create a dedicated database role and development database in `psql` (replace the example password with a private local password):

```sql
CREATE ROLE ledgerline_app LOGIN PASSWORD 'replace_with_a_local_password';
CREATE DATABASE ledgerline_dev OWNER ledgerline_app;
```

Copy `.env.example` to `.env` in the repository root, then set the local PostgreSQL credentials. In PowerShell:

```powershell
Copy-Item .env.example .env
```

The configuration uses `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`; `PORT` sets the API port. `.env` is excluded from Git. Never commit real credentials. If you already have a configured development database, keep using it; do not recreate it to follow this example.

## Install and run

From the repository root, install packages, apply migrations, optionally insert the repeatable synthetic seed records, and start both development servers. In PowerShell, use `npm.cmd` if the local execution policy blocks `npm.ps1`.

```powershell
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

The web app normally runs at `http://localhost:5173` and proxies `/api` requests to `http://localhost:3000`. The seed adds two synthetic batches and six trade rows; it includes a repeated ALPHA source reference. The seed is separate from CSV uploads and is safe to rerun.

The SQL migrations create the batch/trade, reconciliation, exception, and audit tables, indexes, constraints, and audit-event immutability guards. `npm.cmd run db:migrate:down` rolls back the latest migration. **Down migrations are destructive and should only be run against disposable databases.**

## Checks

Run the existing checks from the repository root:

```powershell
npm.cmd run test:unit
npm.cmd run test:db
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

The database integration suite creates a uniquely named `ledgerline_test_*` schema in the database configured by `.env`, migrates and tests only that schema, then drops it. It does not reset existing rows or the `public` schema. The database role needs permission to create schemas. Use a local development database for this suite.

The root `lint` script runs ESLint and a repository-wide Prettier check. The current checkout has a known Prettier warning in `apps/web/tsconfig.json`; the file is not changed by the workspace ESLint commands.

## Current limitations

- There is no authentication or authorization. Do not expose the development API publicly.
- Audit actor attribution uses the fixed `anonymous-operator` application label; actions are not tied to authenticated users.
- The system only accepts the documented synthetic ALPHA and BRAVO CSV formats. It does not connect to external market data or real financial systems.
- No production deployment configuration or browser-based end-to-end test suite is included. The complete workflow should be manually verified in a browser.

## Repository layout

```text
apps/
  api/       Express API, import/reconciliation modules, PostgreSQL pool
  web/       React pages, API client, shared components, styles
db/
  migrations/ Versioned PostgreSQL migrations
  seed.mjs    Repeatable synthetic sample records
samples/      Synthetic ALPHA and BRAVO CSV examples
tests/db/     Isolated-schema HTTP and PostgreSQL integration tests
```
