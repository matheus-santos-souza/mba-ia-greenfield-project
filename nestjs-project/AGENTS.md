# AGENTS.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** — **never** start `nestjs-api` or `video-worker` unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

```bash
docker compose up -d db minio minio-init redis mailpit
```

After starting infrastructure, confirm readiness. `minio-init` is a one-shot container and must exit successfully rather than remain `running`:

```bash
docker compose ps --all
docker compose exec db pg_isready -U streamtube
curl --fail http://localhost:9000/minio/health/live
docker compose ps --all minio-init
docker compose exec redis redis-cli ping
curl --fail http://localhost:8025/api/v1/messages
```

Expect PostgreSQL to accept connections, MinIO's health probe to succeed, `minio-init` to exit with code `0`, Redis to return `PONG`, and Mailpit's API to respond. Only start the application services when explicitly requested.

## Development Environment

This project runs inside Docker. Copy `.env.example` to `.env` before first startup. To run the complete application stack explicitly:

```bash
# Build and start API, worker, and their dependencies
docker compose up -d --build nestjs-api video-worker

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Follow application logs
docker compose logs -f nestjs-api video-worker
```

Services defined by `compose.yaml`:

| Service | Role | Host access |
|---|---|---|
| `nestjs-api` | NestJS HTTP API | `http://localhost:3000` |
| `video-worker` | Standalone Nest context for asynchronous media processing | no published port |
| `db` | PostgreSQL 17 (`streamtube` database and credentials) | `localhost:5432` |
| `minio` | Private S3-compatible media storage | API `localhost:9000`, console `localhost:9001` |
| `minio-init` | One-shot creation of the private `STORAGE_BUCKET` | no published port; exits `0` |
| `redis` | Redis 8 broker/persistence for BullMQ | `localhost:6379` |
| `mailpit` | SMTP capture and inspection API | SMTP `localhost:1025`, UI/API `localhost:8025` |

The two Node services share `Dockerfile.dev` (Node 25 with FFmpeg and FFprobe installed) and the project bind mount. `video-worker` receives a configurable stop grace period before active media processes are force-killed.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify infrastructure
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl --fail http://localhost:9000/minio/health/live
curl --fail http://localhost:8025/api/v1/messages

# Check container logs
docker compose logs nestjs-api video-worker db minio redis mailpit

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands

Prefix build/test/quality/API commands with `docker compose exec nestjs-api`. When explicitly running a worker script manually, use `docker compose exec video-worker` instead.

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Standalone video worker with hot-reload
npm run start:worker:prod                # Run compiled dist/video-worker

npm test                                 # Unit + integration tests, sequential
npm run test:integration                 # Integration tests only, sequential
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps --all
docker compose logs nestjs-api video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl --fail http://localhost:9000/minio/health/live
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share PostgreSQL, MinIO, Redis, and Mailpit infrastructure. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:integration
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites clean shared database, storage, queue, and email state concurrently. Integration tests exercise real PostgreSQL, MinIO/S3, Redis/BullMQ, Mailpit, and FFmpeg/FFprobe whenever those external contracts are under test; unit tests isolate owned boundaries. Detailed setup and cleanup conventions live in `.codex/skills/testing-guide-nestjs-project/` and `.claude/rules/nestjs-testing.md`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the root `AGENTS.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to `start:dev`, `start:prod`, `start:worker:dev`, `start:worker:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix | Purpose | External I/O | Location |
|---|---|---|---|
| `*.spec.ts` | **Unit or module contract** — pure logic with mocked owned boundaries, or DI/configuration compilation | Forbidden for logic tests; allowed deliberately for configured module contracts | Next to the source file |
| `*.integration-spec.ts` | **Integration** — real PostgreSQL, MinIO/S3, Redis/BullMQ, FFmpeg, Mailpit, repositories, or combinations | Required | Next to the source file |
| `*.e2e-spec.ts` | **End-to-end** — full HTTP cycle via `supertest` and real backend dependencies | Required | `nestjs-project/test/` |

A behavioral test that opens PostgreSQL, MinIO, Redis, or a real media process must be `*.integration-spec.ts`. The deliberate exception is a `*.module.spec.ts` compilation/configuration contract, which may initialize the real configured TypeORM/BullMQ modules to prove runtime DI wiring. A test that boots the full Nest application and makes HTTP calls must be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. Database, storage, Redis, JWT, and mail settings can diverge from the Compose network.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`.
- Controllers handle HTTP routing; services hold business logic; both are scoped to their module.
- External systems are accessed through dedicated modules and application-owned ports/adapters.
- The HTTP API and the standalone worker are separate Nest entry points. The worker has no HTTP controller and handles asynchronous jobs through BullMQ/Redis.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
