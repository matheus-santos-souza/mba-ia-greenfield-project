---
paths:
  - 'nestjs-project/src/config/queue.config.ts'
  - 'nestjs-project/src/video-worker.ts'
  - 'nestjs-project/src/videos/entities/video-processing-outbox.entity.ts'
  - 'nestjs-project/src/videos/processing/**'
  - 'nestjs-project/src/videos/video.repository.ts'
description: 'Transactional outbox, BullMQ/Redis jobs, idempotent video processing, retries, polling, and graceful shutdown'
---

# Video Processing Queue Rules

## Transactional Outbox

- Completing an upload changes the upload to `completed`, changes the video to `processing`, and inserts `video.processing.requested` in one PostgreSQL transaction.
- Enforce one event per `(video_id, event_type)` with a database constraint. Do not enqueue directly from the request transaction and do not rely on an in-memory event flag.
- The event payload and queue job use `{ version: 1, eventId, videoId }`. Version the shape before making incompatible changes.
- Lock upload/video rows while evaluating terminal state. Completion is idempotent and must not create duplicate outbox events.

## Relay Publication

- The API-side `VideoProcessingOutboxRelay` owns outbox-to-BullMQ publication; the worker never polls the outbox.
- Claim a bounded batch with a lease so multiple API replicas can relay safely. Do not hold database locks while calling Redis.
- Publish with deterministic `jobId = video-processing-{eventId}` so retrying a publication is deduplicated by BullMQ.
- Mark `published_at` only after `queue.add()` succeeds.
- On publication failure, persist a bounded sanitized error, increment attempts, and schedule bounded exponential backoff. The outer polling loop may log and continue; `relayOnce()`/publication must still expose failure.
- Stop polling promptly during application shutdown and await the active relay iteration.

## BullMQ Configuration

- Use `VideoProcessingQueueModule` as the single registration point for Redis and queue defaults.
- Container configuration uses `REDIS_HOST=redis`, never `localhost`.
- Attempts, exponential backoff delay, physical queue name, and worker concurrency come from validated configuration.
- Keep completed/failed job retention bounded. Do not configure unbounded Redis history.
- `VIDEO_PROCESSING_QUEUE` is the stable Nest injection token/logical name; configuration may override the physical queue name for isolated tests.

## Processor Semantics

- `VideoProcessor` accepts only `video.processing.requested`; reject unsupported job names.
- BullMQ owns delivery attempts. Processing code must rethrow failures so retry/backoff occurs.
- Determine terminal failure from `attemptsMade` and configured attempts. Intermediate failures leave the video in `processing`; only the last attempt writes a sanitized `processing_error` and status `error`.
- Processing is idempotent: a fully populated `ready` video returns without reading storage or rewriting artifacts.
- Use deterministic source/playback/thumbnail keys so a retry converges on the same records and objects.

## Worker Process and Shutdown

- Bootstrap the consumer with `NestFactory.createApplicationContext(VideoWorkerModule)`; do not start an HTTP listener or import controllers.
- Enable Nest shutdown hooks. On shutdown, request BullMQ's graceful close and wait up to `VIDEO_WORKER_SHUTDOWN_GRACE_SECONDS`.
- Only after the grace timeout, terminate active media processes and force-close the BullMQ worker.
- Do not leave polling timers, Redis connections, child processes, or DataSources open.

## Tests

- Queue/outbox integration uses real PostgreSQL and Redis, a process-specific physical queue, and deterministic job IDs.
- Full processor integration uses a real BullMQ `Queue`/`Worker`, PostgreSQL, MinIO, and FFmpeg/FFprobe.
- Use `obliterate({ force: true })` only on the isolated test queue; e2e tests drain the application queue. Never use `FLUSHALL`.
- Close worker → obliterate/close queue → close Nest module/DataSource in that order.
