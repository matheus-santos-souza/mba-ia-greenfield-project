---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-20
scope_description: "Backend inicial da Fase 03: upload resumable de vídeos de até 10GB, armazenamento S3-compatible, processamento assíncrono, artefatos de reprodução, entrega por streaming/download e identificadores públicos únicos."
---

# Technical Decisions — Backend Upload and Video Processing

_Subprojects in scope:_

- `nestjs-project/` — owns the upload control plane, video/upload persistence, S3-compatible storage adapter, queue producer, standalone FFmpeg worker, processing state, and signed media access.
- `next-frontend/` — explicitly deferred from this initial Phase 03 scope. This document only defines the backend contracts that a later frontend slice may consume; it makes no frontend library, component, or browser-orchestration decision.

_Scope sources: `docs/project-plan.md` (Phase 03) and `docs/phase-03-videos-instrucoes.md`._

> Inherited constraints (not reopened): NestJS remains the authorization and business-rule authority (`phase-02-auth/TD-02..TD-03`); the API remains the OpenAPI contract producer (`openapi-docs-nestjs/TD-02`); backend services throw domain errors normalized by the existing exception filters (`phase-02-auth/TD-07`); and inter-container connections use Docker Compose service names, never `localhost`. How a future frontend consumes these backend contracts is intentionally deferred.

---

## TD-01: Resumable Upload API and Storage Contract

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB request cannot be buffered or proxied through NestJS without coupling API capacity to upload duration. The backend needs a resumable contract that creates the draft first, authorizes each upload attempt, retries only failed bytes, persists resume metadata, and completes the object before processing is enqueued. This decision defines only the API/storage side of that contract and depends on TD-02.

**Options:**

### Option A: S3 Multipart Upload with API-presigned parts

NestJS exposes authenticated operations to create a draft/upload session, sign individual parts, list persisted/uploaded parts, complete, and abort an S3 Multipart Upload. The upload session retains the provider upload ID and object key so any future authorized client can transfer parts directly to object storage and resume interrupted work without sending media bytes through the API.

- **Pros:** Keeps 10GB payloads out of NestJS; retries only failed parts; supports parallel parts and native S3/MinIO primitives; preserves backend authorization over keys and completion.
- **Cons:** Requires several control-plane operations, lifecycle cleanup for abandoned multipart uploads, careful expiry handling for presigned part URLs, and a future client compatible with the multipart contract.

### Option B: tus 1.0 with a dedicated tus server

A `tusd` or tus-node-server container receives resumable `PATCH` requests and writes to S3-compatible storage. NestJS authorizes and associates uploads through hooks or metadata rather than owning the whole transfer protocol.

- **Pros:** Purpose-built open resumable protocol; mature client/server implementations; natural pause/resume and checksum/expiration extensions.
- **Cons:** Adds and operates another public-facing service, hook/auth contract, and observability surface; the tus server remains in the media data path and internally maps the stream to S3 multipart operations.

### Option C: Application-managed chunk endpoint through NestJS

NestJS receives each application-defined chunk and assembles or forwards it to storage. Resume state, chunk validation, cleanup, and completion semantics are all owned by the API.

- **Pros:** Total application-level control over every chunk without relying on provider-specific multipart endpoints.
- **Cons:** Sends up to 10GB through NestJS, consumes application connections and bandwidth, creates custom resumability semantics, and contradicts the non-blocking requirement.

**Recommendation:** **Option A (S3 Multipart Upload with API-presigned parts)** — it reuses the object store's native resume/parallelism primitives, keeps media bytes outside NestJS, and avoids introducing a separate tus service while the API retains control of identity, authorization, keys, and completion.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-02: S3-Compatible Bucket and Object-Key Organization

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo", "Download do vídeo pelo usuário"

**Context:** S3-compatible object storage and MinIO in local Docker are fixed phase constraints, not choices to reopen. The open decision is how the API and worker organize private source, playback, and thumbnail objects so multipart cleanup, retries, reprocessing, lifecycle policies, signed access, and a future switch to Amazon S3 remain predictable. TD-01 requires the low-level multipart and presigning operations exposed by the S3 API.

**Options:**

### Option A: One private media bucket with deterministic namespaced keys

The API and worker share one configurable private media bucket. Keys are generated by the backend from immutable identifiers, with namespaces such as `videos/{videoId}/sources/{uploadId}`, `videos/{videoId}/playback/{processingVersion}.mp4`, and `videos/{videoId}/thumbnails/{processingVersion}.jpg`. The adapter uses AWS SDK for JavaScript v3 against MinIO locally and the same S3 contract in production.

- **Pros:** Deterministic outputs make retries idempotent; one bucket simplifies configuration and signed access; prefixes still support lifecycle rules and observability per artifact class; keys never trust user filenames.
- **Cons:** Prefix policies require discipline; one bucket has a broader policy surface; distinct retention/access policies must be expressed with prefixes rather than bucket boundaries.

### Option B: Separate private buckets for source, playback, and thumbnails

Each artifact class has a dedicated bucket and deterministic key below the video ID. The storage adapter routes operations to the correct bucket while API and worker receive all bucket names through validated configuration.

- **Pros:** Strong policy and lifecycle isolation; accidental source exposure is less likely; metrics and storage accounting are naturally separated.
- **Cons:** More configuration, provisioning, permissions, and test fixtures; cross-artifact operations span buckets; the phase does not yet need distinct storage providers or public buckets.

### Option C: Channel- and filename-oriented keys

Objects are grouped by channel and retain normalized uploader filenames, for example `channels/{channelId}/videos/{filename}`; derived artifacts use suffixes beside the source.

- **Pros:** Easy for humans to inspect and associate with a channel; preserves recognizable names.
- **Cons:** Title/filename collisions and renames leak into storage concerns; untrusted names require normalization; ownership changes affect layout; deterministic retry/version semantics are weaker.

**Recommendation:** **Option A (one private media bucket with deterministic namespaced keys, accessed through AWS SDK v3)** — it honors the fixed MinIO/S3-compatible architecture, keeps object naming independent of user input, and gives multipart, processing retries, lifecycle cleanup, streaming, and future reprocessing stable keys without multiplying infrastructure configuration.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-03: Background Queue Platform

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture already fixes a separate Video Worker and requires the API to return without running FFmpeg. The remaining choice is the durable broker/library contract connecting the NestJS producer to that worker; TD-04 handles delivery and idempotency above the chosen broker.

**Options:**

### Option A: BullMQ 5 + Redis through `@nestjs/bullmq`

NestJS publishes typed video-processing jobs to BullMQ, and a separately bootstrapped worker consumes them. Redis is the broker; BullMQ supplies retries, backoff, job progress, concurrency, deduplication, failure retention, and sandboxed processor support.

- **Pros:** Official NestJS integration; purpose-built Node.js job API; strong fit for long-running processing, progress, retries, and horizontal worker scaling.
- **Cons:** Adds a Redis-compatible service and operational state; worst-case delivery is at least once, so workers must be idempotent; CPU-heavy bookkeeping needs separation from FFmpeg execution.

### Option B: pg-boss on the existing PostgreSQL 17 database

Jobs live in PostgreSQL and workers claim them with `SKIP LOCKED`. It supports transactional enqueue, retries, backoff, dead-letter queues, and avoids adding a broker.

- **Pros:** No new infrastructure; job creation can participate directly in the video database transaction; compatible with the project's Node 25/PostgreSQL 17 runtime.
- **Cons:** Queue load competes with application data; weaker NestJS-native integration and job-progress ergonomics; scaling/monitoring ties media workload health to the primary database.

### Option C: RabbitMQ 4 durable queues

The API publishes persistent messages with confirms and the worker manually acknowledges after processing. Durable or quorum queues provide a general AMQP broker independent of the Node.js runtime.

- **Pros:** Mature broker semantics, routing flexibility, cross-language consumers, and strong operational tooling.
- **Cons:** More AMQP acknowledgement/retry/dead-letter plumbing, another service to operate, and less direct NestJS job-oriented support than BullMQ for a single processing workflow.

**Recommendation:** **Option A (BullMQ 5 + Redis through `@nestjs/bullmq`)** — the architecture already calls for a dedicated queue, and BullMQ offers the best NestJS 11 fit plus the progress, retry, concurrency, and worker-isolation primitives needed by FFmpeg without introducing AMQP-level plumbing.

**Decision:** A
**Libraries:** `@nestjs/bullmq`, `bullmq`

---

## TD-04: Video Worker Execution and FFmpeg Boundary

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** FFmpeg is CPU-, memory-, and I/O-intensive and must not share the API request lifecycle. The architecture requires a worker, but the execution boundary still determines deployability, failure isolation, dependency packaging, scaling, graceful shutdown, and how queue jobs invoke `ffprobe`/`ffmpeg`.

**Options:**

### Option A: Separate Docker service with a standalone NestJS application context

The repository builds an image containing the backend worker entry point plus pinned FFmpeg/ffprobe binaries. A dedicated `video-worker` Compose service starts a NestJS application context without HTTP, registers the BullMQ consumer, invokes FFmpeg subprocesses through a focused media-processing adapter, and shares typed domain/application contracts with the API without bootstrapping API controllers.

- **Pros:** Isolates API latency and failures from media CPU/memory pressure; independently scalable; fits the existing NestJS dependency-injection and configuration model; one codebase can share contracts while keeping runtime responsibilities separate.
- **Cons:** Requires an additional entry point, container command, health/shutdown handling, FFmpeg-enabled image, and integration tests that coordinate API, queue, storage, database, and worker.

### Option B: BullMQ consumer inside the API process/container

The NestJS HTTP application also registers and runs the video processor. FFmpeg is installed in the API image and job concurrency is limited in process.

- **Pros:** Fewest services and entry points; simplest local boot; direct reuse of all application providers.
- **Cons:** FFmpeg competes with HTTP requests for CPU/memory; worker crashes or deployments affect the API; cannot scale API and processing independently; violates the architecture's separate-worker boundary.

### Option C: Separate non-NestJS worker package/process

A minimal Node.js process consumes BullMQ directly and invokes FFmpeg using shared TypeScript types, but does not boot a NestJS application context.

- **Pros:** Small runtime surface and fast startup; clear infrastructure boundary; avoids loading HTTP-oriented Nest modules.
- **Cons:** Duplicates configuration, logging, lifecycle, storage, database, and dependency-wiring conventions; shared providers need new framework-agnostic packages; increases repository structure before that split is necessary.

**Recommendation:** **Option A (separate Docker service with a standalone NestJS application context and an isolated FFmpeg adapter)** — it satisfies the explicit worker/container requirement, protects API responsiveness, supports independent concurrency and restarts, and reuses current NestJS 11 conventions without turning the HTTP application into the worker runtime.

**Decision:** A

---

## TD-05: Processing Delivery, Retry, and Idempotency Semantics

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** With BullMQ/Redis, completing an upload in PostgreSQL and publishing a job are two separate writes. A crash between them can leave an uploaded video unprocessed; retries or stalled-job recovery can also execute the same FFmpeg work more than once. The system needs a business-level reliability contract rather than assuming exactly-once broker delivery. This decision depends on TD-03 and TD-04.

**Options:**

### Option A: Direct enqueue plus periodic reconciliation

The completion request commits the uploaded state and then enqueues a deterministic job. A scheduled reconciler later finds uploaded videos with no successful processing state and republishes missing work; the worker uses deterministic output keys so retries can safely overwrite or skip completed artifacts.

- **Pros:** Simple request path and no outbox relay; reconciliation repairs broker outages and crash gaps eventually.
- **Cons:** Automatic processing may be delayed until reconciliation; correctness is split between request, scheduler, and worker; transient inconsistencies are expected.

### Option B: Transactional outbox plus at-least-once idempotent worker

The upload-completion transaction atomically records both the completed upload and an outbox event. A relay publishes a deterministic BullMQ job, and the worker treats persisted processing state plus deterministic object keys as the source of truth; retries use bounded exponential backoff and terminal failures remain inspectable.

- **Pros:** Removes the PostgreSQL↔Redis dual-write loss window; tolerates duplicate delivery and stalled recovery; gives auditable pending/failed work without claiming impossible end-to-end exactly-once execution.
- **Cons:** Adds an outbox table, relay, retention policy, and idempotency checks; successful processing is intentionally eventually consistent after upload completion.

### Option C: External durable workflow engine

A workflow service such as Temporal owns the multi-step process, retries, timers, and recovery history; API and worker implement activities.

- **Pros:** Strongest visibility and durable orchestration for complex, long-running workflows; explicit step-level retries and compensation.
- **Cons:** Adds a substantial platform and programming model for a phase with one bounded processing pipeline; overlaps BullMQ and increases operational scope.

**Recommendation:** **Option B (transactional outbox + at-least-once idempotent worker)** — it closes the only loss window between upload completion and queue publication while accepting BullMQ's real delivery semantics and keeping retries safe through persisted state and deterministic outputs.

**Decision:** B

---

## TD-06: Draft, Upload Session, and Video Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The acceptance contract requires the persisted video lifecycle `Rascunho`, `Processando`, `Pronto`, and `Erro`, while multipart transfer state has different transitions and recovery data. The backend must resume uploads, recover processing, and expose an unambiguous status without coupling the video row to transient BullMQ state. Phase 04 publication visibility remains a separate future concern.

**Options:**

### Option A: Required Video status lifecycle plus a separate Upload Session

Creating an upload atomically creates a Video in `DRAFT` (`Rascunho`) and an Upload Session that owns the storage upload ID, object key, expected size, expiry, and completion/abort state. Successful multipart completion transitions the Video to `PROCESSING`; successful worker completion transitions it to `READY`, while an exhausted processing attempt transitions it to `ERROR`. A controlled retry moves `ERROR` back to `PROCESSING`; future publication visibility is modeled separately.

- **Pros:** Implements the required four persisted states exactly; preserves single responsibility; supports retrying or replacing an upload without replacing the video URL; keeps Phase 04 visibility independent from technical readiness.
- **Cons:** Adds a relation and explicit transition rules; completion must validate and coordinate two persisted records.

### Option B: One Video row with a single overloaded status

The video row stores upload identifiers and moves through a single enum such as uploading → processing → draft → published/failed.

- **Pros:** Fewest tables and straightforward queries for the first happy path.
- **Cons:** Conflates publication, transfer, and processing; cannot express combinations such as “draft + processing failed” cleanly; future re-upload and Phase 04 transitions become fragile.

### Option C: Queue/workflow state as the operational source of truth

PostgreSQL stores only the draft and final metadata; clients obtain upload and processing status from S3 and the broker/workflow engine.

- **Pros:** Smaller relational model and fewer status columns.
- **Cons:** Couples API availability and history to ephemeral infrastructure, complicates authorization and OpenAPI responses, and makes recovery/audit queries difficult.

**Recommendation:** **Option A (Video with `DRAFT → PROCESSING → READY | ERROR` plus a separate Upload Session)** — it implements the required database lifecycle, lets the draft receive a stable identity before bytes arrive, preserves all multipart resume data, and leaves Phase 04 visibility independent.

**Decision:** A

---

## TD-07: FFmpeg Processing, Thumbnail, and Canonical Playback Artifact

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** The worker must run ffprobe to persist duration and technical metadata and FFmpeg to extract a thumbnail. Range delivery alone does not make arbitrary uploaded codecs broadly playable, and serving only the source makes playback depend on the uploader's container and metadata layout. The processing contract therefore must choose whether to retain only the source or generate a canonical playback artifact as well.

**Options:**

### Option A: Serve the original object with HTTP Range

The worker probes duration/metadata and extracts a thumbnail but does not transcode. Playback points to the uploaded object and relies on browser codec support plus byte-range requests.

- **Pros:** Fastest processing, lowest extra storage, and original quality is untouched.
- **Cons:** Cannot guarantee browser playback; MP4 files with metadata at the end may start poorly; incompatible sources fail despite a successful upload.

### Option B: One normalized progressive MP4 master for playback

The worker runs ffprobe, persists duration and a controlled metadata projection, produces an H.264/AAC MP4 with the `moov` atom moved to the beginning (`+faststart`), and extracts one thumbnail at a deterministic timestamp derived from the probed duration. The source is retained as the reprocessing/download master, while the normalized object is the stable Range-capable playback contract.

- **Pros:** Broad browser compatibility; one output keeps Phase 03 processing and storage bounded; progressive playback works with ordinary signed Range GETs.
- **Cons:** Transcoding can be slow and CPU-intensive; no adaptive bitrate for weak networks; retaining source plus derived media increases storage use.

### Option C: Multi-rendition HLS from the first release

The worker transcodes an adaptive bitrate ladder and emits a master playlist plus segments, thumbnail, and source master. The frontend uses an HLS-capable player and storage serves many small objects.

- **Pros:** Best playback adaptation and seeking behavior across network conditions; natural foundation for production-scale video delivery.
- **Cons:** Multiplies FFmpeg time, storage objects, testing, player logic, and failure states beyond the phase's stated metadata/thumbnail scope.

**Recommendation:** **Option B (ffprobe metadata + deterministic thumbnail + one H.264/AAC progressive MP4 with `+faststart`, retaining the source)** — it produces a broadly playable streaming artifact and the required metadata/thumbnail with one bounded pipeline, while deferring HLS rendition complexity.

**Decision:** B

---

## TD-08: Streaming and Download Access Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Uploads and drafts cannot live in a public bucket, and future public/unlisted visibility must remain enforceable by the API. At the same time, proxying playback or a 10GB download through NestJS would recreate the bottleneck avoided by TD-01. This backend decision defines how the API grants time-bounded access to storage objects and depends on TD-02 and TD-07.

**Options:**

### Option A: Private bucket with short-lived presigned GET URLs

The API authorizes the request and returns a short-lived signed URL for the appropriate object. Playback targets the normalized MP4; the client sends `Range` to MinIO/S3, which returns `206 Partial Content` for satisfiable byte ranges. Download uses a separately signed response with attachment `Content-Disposition`, while object keys remain private.

- **Pros:** Storage serves all media bytes and Range responses; works for drafts and later visibility rules; separates playback and download disposition without exposing credentials.
- **Cons:** URLs expire and must be refreshed; browser-to-storage CORS is required; revocation is bounded by the remaining URL lifetime.

### Option B: NestJS byte proxy

The client requests media from NestJS, which validates access and streams storage bytes while forwarding Range and content headers.

- **Pros:** Centralized authorization, logging, stable same-origin URL, and immediate access revocation.
- **Cons:** Application servers carry every playback/download byte and long-lived connection, increasing bandwidth, scaling, timeout, and backpressure risk for files up to 10GB.

### Option C: CDN in front of the private bucket with signed access

A CDN serves cached media and validates signed URLs or cookies; the API issues access grants. Storage remains private and is reachable only through the CDN origin configuration.

- **Pros:** Best global delivery, caching, range performance, and origin offload; preserves private objects.
- **Cons:** Introduces a production provider, cache invalidation, signing keys, and local-development divergence before deployment infrastructure is in scope.

**Recommendation:** **Option A (private bucket + short-lived presigned GET URLs)** — it preserves API authorization without placing video bytes on the NestJS path and remains a clean origin contract that a CDN can front later without changing object ownership or processing outputs.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-09: Public Video URL Identifier Contract

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Existing entities use UUID primary keys, while the phase requires a unique, conflict-free URL identifier stored with the video. The identifier must be generated before upload completion, immutable across title edits and re-uploads, and protected from residual collision risk by PostgreSQL.

**Options:**

### Option A: Expose the existing UUID primary key

The video uses the project's established UUID primary key directly in `/videos/{id}`.

- **Pros:** No second identifier, index, dependency, or lookup; consistent with existing entities and OpenAPI UUID formats.
- **Cons:** A canonical UUID string is comparatively long and exposes the relational identifier as the public contract; changing public URL style later requires aliases or redirects.

### Option B: Separate 21-character NanoID public ID

The video keeps an internal UUID primary key and receives an immutable, URL-safe 21-character NanoID at draft creation. A database unique constraint is authoritative; the application retries generation on the extraordinarily unlikely unique violation.

- **Pros:** Shorter than UUID while retaining comparable random collision probability; safe for URLs and distributed generation; internal relations remain consistent with the current UUID model.
- **Cons:** Adds one column/index and an application dependency; every public lookup translates public ID to the internal UUID; collision handling still must exist despite the low probability.

### Option C: Human-readable title slug plus random suffix

The public ID combines a normalized title slug with a short random suffix and remains frozen after creation.

- **Pros:** More readable and potentially useful for search snippets; random suffix reduces collisions.
- **Cons:** The draft is created before a final title exists, Unicode normalization and reserved words add policy, and URLs become longer while still requiring a unique constraint/retry.

**Recommendation:** **Option B (internal UUID + immutable 21-character NanoID public ID)** — it preserves the repository's UUID relational convention while providing the dedicated URL identifier required by the phase; a unique index and retry turn probabilistic generation into a collision-safe database contract.

**Decision:** B
**Libraries:** `nanoid`

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Resumable upload API and storage contract | S3 Multipart Upload with API-presigned parts | A |
| TD-02 | Backend | S3-compatible bucket and object-key organization | One private media bucket with deterministic namespaced keys via AWS SDK v3 | A |
| TD-03 | Backend | Background queue platform | BullMQ 5 + Redis via `@nestjs/bullmq` | A |
| TD-04 | Backend | Video worker execution and FFmpeg boundary | Separate Docker service with a standalone NestJS application context | A |
| TD-05 | Backend | Processing delivery, retry, and idempotency | Transactional outbox + at-least-once idempotent worker | B |
| TD-06 | Backend | Draft/upload/video status lifecycle | Video `DRAFT → PROCESSING → READY \| ERROR` + separate Upload Session | A |
| TD-07 | Backend | FFmpeg processing, thumbnail, and canonical playback artifact | ffprobe metadata + thumbnail + H.264/AAC progressive MP4 with `+faststart` | B |
| TD-08 | Backend | Streaming and download access | Private bucket + short-lived presigned GET URLs with Range/206 | A |
| TD-09 | Backend | Public video URL identifier contract | Internal UUID + immutable 21-character NanoID | B |

---

## Downstream Alignment Notes

- `testing-guide-nestjs-project/references/external-systems.md` currently prescribes a local-filesystem storage adapter for tests. That remains useful for isolated service tests, but it cannot validate S3 multipart signing, `ETag`/part completion, CORS assumptions, or Range GET behavior. If TD-01/TD-02 Option A is selected, planning must add focused MinIO integration coverage and update the guide rather than silently treating the filesystem adapter as contract-equivalent.
- `next-frontend/` has no open technical decision in this initial backend scope. A later frontend research/planning slice must decide its multipart orchestration and media-consumption behavior against the API contracts selected here.
- New Docker connections must follow the repository rule and use Compose service names (for example `minio` and `redis`) from API/worker containers, never `localhost` or `127.0.0.1`. Any signed URL returned to an external client must use a separately routable storage endpoint because Docker service names are only valid inside the Compose network.

---

## Research Sources

- [Amazon S3 multipart upload overview and limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — part retries, resume/list lifecycle, checksums, 10,000-part limit, and explicit complete/abort behavior.
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) and [S3 presigned URL guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — TypeScript S3 commands and time-limited upload/download access.
- [MinIO object storage](https://github.com/minio/minio) — S3-compatible local object-storage service selected by the phase instructions.
- [Amazon S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html) and [incomplete multipart lifecycle cleanup](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html) — external-client access and abandoned-part requirements.
- [tus resumable upload protocol 1.0](https://tus.io/protocols/resumable-upload) and [tusd](https://github.com/tus/tusd) — byte-offset resume and the dedicated-server alternative.
- [NestJS queues documentation](https://docs.nestjs.com/techniques/queues), [NestJS standalone applications](https://docs.nestjs.com/standalone-applications), and [BullMQ documentation](https://docs.bullmq.io/) — `@nestjs/bullmq`, standalone worker context, retries/backoff, concurrency, stalled jobs, and idempotent-job guidance.
- [pg-boss](https://github.com/timgit/pg-boss) and [RabbitMQ reliability guide](https://www.rabbitmq.com/docs/reliability) — PostgreSQL and AMQP broker alternatives.
- [Amazon S3 GetObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) — byte Range requests and `206 Partial Content` responses from object storage.
- [FFmpeg formats documentation](https://ffmpeg.org/ffmpeg-formats.html) — MP4 `+faststart` and HLS output behavior.
- [NanoID](https://github.com/ai/nanoid), [ULID specification](https://github.com/ulid/spec), and [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html) — public identifier length, randomness, ordering, and collision trade-offs.
