# Trade Reconciliation Platform

## Project purpose

Build a portfolio-quality learning application that imports synthetic trade records from two systems, reconciles them, and supports investigation of exceptions. This is not a real trading system: never execute trades or move money.

## Working principles

- Work in small milestones. Before substantial implementation, explain the plan and key design choices; do not generate the whole application at once.
- Preserve existing work. Explain proposed changes that would replace it, and ask before destructive actions, paid services, or changes outside this project directory.
- Use strict TypeScript; separate HTTP routes, business logic, persistence, and validation.
- Keep reconciliation rules deterministic and independent of HTTP and database layers.
- Validate all external input on the server and use parameterized SQL.
- Use database transactions when related writes must succeed together.
- Represent and compare financial values exactly; do not use JavaScript floating-point arithmetic for financial comparisons.
- Use SQL migrations, meaningful errors and logs, tests for normal and edge cases, and synthetic sample data.
- Never commit credentials or claim checks passed unless they were run.
- Prefer simple, well-supported dependencies; avoid premature abstraction, microservices, and unnecessary AI features.
- Explain unfamiliar concepts and architectural decisions as the project develops.

## Expected stack

- Frontend: React, TypeScript, Vite.
- Backend: Node.js, Express, TypeScript.
- Database: PostgreSQL, parameterized queries, SQL migrations.
- Tests: Vitest for unit tests and an HTTP integration testing library.
- Local environment: Docker Compose where useful; GitHub Actions for CI.

## Repository conventions

- Keep the frontend in `apps/web`, the API in `apps/api`, and pure domain rules in `packages/domain` when that package is introduced.
- Keep Express app construction separate from process startup so the app can be integrated and tested without opening a port.
- Use npm workspaces and commit the generated lockfile when dependencies are installed.
- Put local secrets in an ignored `.env` file and document variable names in `.env.example`.
