# Implementation plan

## Purpose and initial architecture

Build a single-repository TypeScript application with two deployable parts: a React/Vite browser client and an Express API. PostgreSQL is the source of truth. The API validates requests and coordinates use cases; domain logic handles import validation and deterministic reconciliation without depending on Express or SQL; repositories own parameterized database access. SQL migrations define schema changes. Begin as a modular monolith so the boundaries are clear without the overhead of multiple services.

```text
Browser (React + TypeScript)
        | HTTP/JSON
Express API (routes -> validation -> application services)
        |                         |
Repositories (parameterized SQL) Domain (import + reconciliation rules)
        |                         |
        +------ PostgreSQL -------+
```

## Proposed repository structure

```text
trade-reconciliation-platform/
├── AGENTS.md
├── README.md
├── package.json                 # workspace scripts and shared development commands
├── package-lock.json
├── .gitignore
├── .env.example                 # names and safe local defaults only; no secrets
├── docker-compose.yml           # local PostgreSQL, when introduced
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app.ts            # construct Express app, no listen side effect
│   │       ├── server.ts         # process startup and shutdown
│   │       ├── routes/
│   │       ├── middleware/
│   │       └── modules/          # import, reconciliation, exceptions, dashboard
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── src/
│           ├── app/
│           ├── features/         # imports, exceptions, dashboard
│           └── shared/
├── packages/
│   └── domain/                   # pure reconciliation and validation types/rules
├── db/
│   ├── migrations/
│   └── seeds/                    # reproducible synthetic sample records
├── tests/
│   └── integration/
└── docs/
    ├── implementation-plan.md
    └── reconciliation-rules.md   # added when matching rules are specified
```

Keep the first version in one repository and one API process. The `packages/domain` boundary protects critical matching logic from HTTP/database concerns; it can remain a workspace package or be folded into the API if workspace overhead is not useful.

## Main data entities and relationships

- **ImportBatch**: one uploaded file from one source system; stores source, filename, timestamps, and counts/status. Has many imported trade rows and validation errors.
- **ImportedTrade**: a parsed source record belonging to one batch; preserves original source values and normalized values, plus row number and validation outcome. Valid records can be linked to reconciliation results.
- **ReconciliationRun**: one deterministic comparison over a selected pair/set of batches; records rule version, start/completion status, and summary counts.
- **ReconciliationResult**: one outcome in a run, such as exact match, field mismatch, duplicate, missing on source A, or missing on source B. Links the relevant imported trades; mismatches include machine-readable field differences.
- **Exception**: an actionable discrepancy associated with a result; carries current status and assignment/details as the UI needs evolve.
- **ExceptionEvent**: append-only history for status changes, investigation notes, and resolutions; records actor, reason, and timestamp. An exception has many events.

Use database numeric/decimal columns for prices and quantities where their precision is defined; preserve raw CSV strings for traceability. Avoid floating-point conversion in the matching path. Exact schema constraints and whether a result and exception are one-to-one should be settled alongside the matching workflow, before their migrations are written.

## Milestones

1. **Foundation** — scaffold npm workspaces for web/API, strict TypeScript, basic health endpoint and Vite page, formatting/type-check scripts, README, and safe environment configuration. Confirm local tools and Git setup.
2. **Database and synthetic data** — local PostgreSQL via Compose, migration runner, initial schema for batches and source trades, and small repeatable sample CSVs/seeds.
3. **Import pipeline** — upload CSVs for the two named synthetic systems, parse and validate required fields/types/dates/currencies/quantities/prices, persist batch and row outcomes transactionally, and report invalid rows. Add unit and API integration tests.
4. **Reconciliation domain** — document matching keys, normalization, duplicate handling, tie-breaking, and mismatch behavior; implement pure deterministic rules and tests before connecting persistence.
5. **Reconciliation persistence and API** — run comparisons over selected batches, persist results and exceptions, expose summary/detail/filter endpoints, and test failure/transaction behavior.
6. **Exception workflow and audit** — dashboard list/detail, investigation and resolution actions with required reasons, append-only events, and authorization boundary appropriate for a local portfolio demo.
7. **Dashboard and polish** — statistics and filters, accessible UI, loading/error/empty states, structured logging, sample walkthrough, and concise architecture/reconciliation documentation.
8. **Delivery quality** — full reproducible setup instructions, GitHub Actions for install/type checks/tests/build, and final review of synthetic-data guarantees and secret handling.

Each milestone should have a small reviewable change and focused checks. Run checks before reporting their status; do not claim unrun checks pass.

## Dependencies and local prerequisites

### Prerequisites

- Git and a GitHub account/repository when ready to publish.
- A currently supported Node.js LTS release with npm (use the same major version locally and in CI; select and document the exact version during scaffold).
- Docker Desktop with Docker Compose for a reproducible local PostgreSQL service, or a compatible local PostgreSQL installation.
- A code editor and terminal.

### Initial dependency choices

- Workspace tooling: npm workspaces and the built-in TypeScript compiler; avoid a monorepo framework initially.
- API: Express and TypeScript; a PostgreSQL client (`pg`) with parameterized SQL; a migration runner such as `node-pg-migrate`.
- Web: React, React DOM, Vite, TypeScript.
- Validation: choose a small runtime schema-validation library at scaffold time (Zod is a reasonable candidate) and use it at API boundaries.
- CSV parsing: select a maintained CSV parser when building imports; do not hand-roll quoting/escaping behavior.
- Tests: Vitest; Supertest for Express integration tests; PostgreSQL-backed integration checks when database flows arrive.
- CI: GitHub Actions using the repository's lockfile and documented Node version.

Keep the final dependency list minimal and verify supported versions when the scaffold is approved. Do not add hosted paid services; all core development can run locally.

## Decisions to make before their milestone

- The two synthetic source-system names and their CSV column formats.
- Trade identity/matching key, duplicate policy, and comparison tolerances/precision.
- Whether local demo users need authentication or whether a clearly documented single-user mode is sufficient.
- Upload limits and whether original files are retained or only parsed rows are stored.
