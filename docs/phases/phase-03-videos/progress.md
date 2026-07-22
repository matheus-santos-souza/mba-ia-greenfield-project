# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Provisionar infraestrutura de mídia e fila
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - Shared Node 25 image build, FFmpeg/FFprobe binaries, Compose rendering, internal DNS, healthy MinIO/Redis services and idempotent private-bucket initialization were verified without launching the application runtimes.
  - The `video-worker` Compose command targets `src/video-worker.ts`, whose standalone runtime implementation is explicitly owned by SI-03.8.
  - `npm install` reported 34 dependency audit findings (2 low, 15 moderate, 16 high, 1 critical); remediation is outside this SI's planned scope.

### SI-03.2 — Persistir vídeos, uploads e outbox
- **Status:** completed
- **Tests:** 23 passing
- **Observations:**
  - The TypeORM-generated `CreateVideosUploadsAndProcessingOutbox` migration was reviewed for named constraints/indexes, cascade foreign keys, partial outbox polling index and reverse-order rollback.
  - Migration generation succeeded but emitted pg's non-blocking deprecation warning about calling `client.query()` while another query is executing.

### SI-03.3 — Implementar boundary S3-compatible
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - Context7 exposed the current official AWS SDK v3 documentation rather than a version-pinned 3.1091.0 snapshot; all adopted APIs were cross-checked against the installed 3.1091.0 types and validated by type-checking and real MinIO integration tests.
  - Browser-facing presigned URLs use the dedicated public-endpoint client; the containerized integration suite intentionally points that endpoint at the Compose `minio` hostname so it can exercise the signed URLs from inside Docker.

### SI-03.4 — Publicar outbox na fila de processamento
- **Status:** completed
- **Tests:** 10 passing
- **Observations:**
  - The manifest range `bullmq@^5.80.9` resolved to 5.80.10 in the lockfile; Context7 exposed current official BullMQ documentation rather than a version-pinned snapshot, so adopted APIs were cross-checked against the installed 5.80.10 declarations and verified by type-checking and real Redis integration tests.
  - Short claim transactions advance `available_at` with a bounded lease before publishing outside the database lock, preventing concurrent relays from sharing a row while preserving crash recovery and later redelivery.

### SI-03.5 — Implementar lifecycle multipart de vídeo
- **Status:** completed
- **Tests:** 23 passing
- **Observations:**
  - Nano ID 5.1.16 is ESM-only while the project's Jest runner executes CommonJS through ts-jest; the Jest transform now opts only the `nanoid` package into ts-jest JavaScript transformation with `allowJs`, preserving the official `nanoid()` implementation in unit, integration and production code.
  - Context7 exposed current Nano ID and TypeORM documentation rather than snapshots pinned to Nano ID 5.1.16 and TypeORM 0.3.28; adopted APIs were cross-checked against installed runtime/types and verified by type-checking plus real PostgreSQL/MinIO integration tests.

### SI-03.6 — Limpar uploads multipart expirados
- **Status:** completed
- **Tests:** 7 passing
- **Observations:**
  - Context7 exposed current TypeORM documentation rather than a snapshot pinned to 0.3.28; the transactional `pessimistic_write` + `skip_locked` query was cross-checked against installed types and verified with concurrent PostgreSQL/MinIO integration coverage.

### SI-03.7 — Expor endpoints de upload multipart
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - Context7 exposed current NestJS and class-validator documentation rather than snapshots pinned to the installed versions; adopted decorators were cross-checked against local types and verified by type-checking plus HTTP E2E coverage.
  - The E2E Jest runner now mirrors the existing scoped ts-jest transformation for ESM-only Nano ID so importing the real `AppModule` exercises the production identifier service.

### SI-03.8 — Processar vídeos no worker isolado
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - Context7 exposed current NestJS, BullMQ and TypeORM documentation rather than snapshots pinned to NestJS 11.1.16, BullMQ 5.80.10 and TypeORM 0.3.28; worker lifecycle, retry and transaction APIs were cross-checked against installed declarations and verified by type-checking plus real Redis/PostgreSQL/MinIO/FFmpeg integration coverage.
  - The processor integration uses a per-process physical BullMQ queue so it remains deterministic even while the Compose `video-worker` service is active; the production worker was also observed recompiling cleanly and bootstrapping its standalone application context.

### SI-03.9 — Autorizar streaming e download por presigned URL
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - Context7 exposed current AWS SDK v3 documentation rather than a snapshot pinned to `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1091.0; the presigning inputs were cross-checked against installed types and verified with real MinIO integration coverage.
  - Streaming signs the canonical playback object without binding a Range header into the URL; the integration test supplies `Range: bytes=0-1023` only when consuming the URL and verifies MinIO's `206`, `Accept-Ranges`, `Content-Range` and partial length response.

### SI-03.10 — Expor redirects de streaming e download
- **Status:** completed
- **Tests:** 16 passing
- **Observations:**
  - Context7 exposed current NestJS Swagger documentation rather than a snapshot pinned to NestJS 11.1.16 and `@nestjs/swagger` 11.4.2; redirect, header and extension decorators were cross-checked against the installed declarations and verified through the exported OpenAPI document.
  - The controller uses the passthrough response only to set the dynamic `Location` header while Nest emits the empty `307` response; authorization and URL signing remain isolated in `VideoDeliveryService`, and `x-redirect-target` documents the object-storage `200`/`206` contract without misrepresenting those statuses as API responses.
