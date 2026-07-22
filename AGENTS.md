# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, process, and publish videos. The platform also covers authentication, channels, email workflows, and an initialized web frontend.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with three main areas:

- `nestjs-project/` — Backend API and standalone video worker (NestJS 11, TypeScript, Express, BullMQ, TypeORM, S3-compatible storage, FFmpeg).
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` — initialized Next.js 16 / React 19 frontend.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls the API via REST and accesses media through object-storage URLs
- **API** (NestJS) → business rules, authentication, database access, storage orchestration, background-job publication, and email
- **Video Worker** (standalone Nest application context with FFmpeg/FFprobe) → consumes BullMQ jobs and processes media asynchronously
- **Database** (PostgreSQL 17) → application and workflow data
- **Object Storage** (S3-compatible; MinIO locally) → private media files and generated artifacts
- **Message Queue** (BullMQ + Redis 8) → asynchronous background jobs
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

The backend runs entirely in Docker containers. When configuring container-to-container connections (database, storage, queue, email, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db`, `STORAGE_INTERNAL_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`, `MAIL_HOST=mailpit`
- **Wrong:** internal service configuration using `localhost`

`STORAGE_PUBLIC_ENDPOINT` is the exception by design: it is embedded in presigned URLs and must be reachable by the URL consumer. It is `http://localhost:9000` for a browser or host client in local development, but tests running inside `nestjs-api` override it to the internal `http://minio:9000` endpoint when they fetch signed URLs themselves.

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Rules

| Rule | Path(s) | Description |
|---|---|---|
| [auth-jwt](.claude/rules/auth-jwt.md) | `nestjs-project/src/auth/**` | JWT and refresh-token rotation rules |
| [nestjs-common-conventions](.claude/rules/nestjs-common-conventions.md) | `nestjs-project/src/**/*.ts` | NestJS common conventions |
| [nestjs-controllers](.claude/rules/nestjs-controllers.md) | `nestjs-project/**/*.controller.ts` | Controller conventions — REST compliance, no silent errors, prefer exception filters over try/catch |
| [nestjs-dtos](.claude/rules/nestjs-dtos.md) | `nestjs-project/**/*.dto.ts` | DTO conventions for input validation and data transfer |
| [nestjs-entities](.claude/rules/nestjs-entities.md) | `nestjs-project/**/*.entity.ts` | TypeORM entity conventions for database models |
| [nestjs-layer-separation](.claude/rules/nestjs-layer-separation.md) | `nestjs-project/**/*.controller.ts`<br>`nestjs-project/**/*.guard.ts`<br>`nestjs-project/**/*.interceptor.ts`<br>`nestjs-project/**/*.pipe.ts`<br>`nestjs-project/**/*.filter.ts` | Layer separation — business logic belongs exclusively in services; controllers, guards, interceptors, pipes, and filters must delegate to services |
| [nestjs-modules](.claude/rules/nestjs-modules.md) | `nestjs-project/src/**/*.module.ts` | NestJS module structure conventions |
| [nestjs-services](.claude/rules/nestjs-services.md) | `nestjs-project/**/*.service.ts` | Service layer error handling — errors must always propagate to upper layers |
| [nestjs-testing](.claude/rules/nestjs-testing.md) | `nestjs-project/**/*.spec.ts`<br>`nestjs-project/**/*.integration-spec.ts`<br>`nestjs-project/**/*.e2e-spec.ts`<br>`nestjs-project/test/**` | Testing conventions for NestJS unit, integration, and e2e tests |
| [object-storage-s3](.claude/rules/object-storage-s3.md) | `nestjs-project/src/storage/**`<br>storage-aware video services/config | S3/MinIO port boundary, deterministic keys, presigned URLs, multipart safety, and error translation |
| [video-processing-queue](.claude/rules/video-processing-queue.md) | queue config, processing outbox/repository, `src/videos/processing/**`, worker bootstrap | Transactional outbox, BullMQ/Redis idempotency, retries, polling, and graceful shutdown |
| [ffmpeg-media-processing](.claude/rules/ffmpeg-media-processing.md) | FFmpeg config/processor/port/shutdown and `Dockerfile.dev` | Safe process execution, canonical media artifacts, bounded diagnostics, temp files, and shutdown |
| [next-frontend-bff-api](.claude/rules/next-frontend-bff-api.md) | `next-frontend/app/api/**/route.ts`<br>`next-frontend/lib/api/**/*.ts` | BFF Route Handlers and the typed upstream client — OpenAPI-anchored wire-shape pipeline |
| [next-frontend-code-quality](.claude/rules/next-frontend-code-quality.md) | `next-frontend/**/*.ts`<br>`next-frontend/**/*.tsx` | TypeScript strict, imports, RSC/client boundary, file naming, `cn()`, Next.js primitives, env access |
| [next-frontend-msw-mocks](.claude/rules/next-frontend-msw-mocks.md) | `next-frontend/mocks/**`<br>`next-frontend/**/*.integration.test.ts`<br>`next-frontend/**/*.integration.test.tsx` | MSW handler typing convention + Route Handler integration test pattern (paths-anchored fixtures) |
| [next-frontend-testing](.claude/rules/next-frontend-testing.md) | `next-frontend/**/__tests__/**`<br>`next-frontend/tests/**`<br>`next-frontend/**/*.test.ts`<br>`next-frontend/**/*.test.tsx`<br>`next-frontend/**/*.integration.test.ts`<br>`next-frontend/**/*.integration.test.tsx`<br>`next-frontend/**/*.e2e-spec.ts` | Test type routing, file placement, forbidden patterns (no real-network Vitest tests) |
| [next-frontend-ui](.claude/rules/next-frontend-ui.md) | `next-frontend/components/**/*.tsx`<br>`next-frontend/app/**/*.tsx`<br>`next-frontend/app/**/*.css` | UI rules: design tokens (no hardcoding), shadcn primitive pattern, custom icon components |
| [typeorm-migrations](.claude/rules/typeorm-migrations.md) | `nestjs-project/**/migrations/**`<br>`nestjs-project/**/*data-source.ts` | Database migration safety rules |
| [typeorm-queries](.claude/rules/typeorm-queries.md) | `nestjs-project/src/**/*.service.ts`<br>`nestjs-project/src/**/*.repository.ts` | TypeORM query pitfalls — silent footguns when reading/writing through repositories |
| [typescript-strict](.claude/rules/typescript-strict.md) | `nestjs-project/src/**/*.ts`<br>`nestjs-project/test/**/*.ts` | TypeScript strictness rules — keep `tsc --noEmit` clean at all times |

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
