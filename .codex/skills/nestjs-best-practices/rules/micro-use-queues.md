---
title: Use BullMQ and a Transactional Outbox for Background Jobs
impact: HIGH
impactDescription: Reliable background processing requires durable intent, idempotent publication, retries, and lifecycle control
tags: microservices, queues, bullmq, redis, outbox, background-jobs
---

## Use BullMQ and a Transactional Outbox for Background Jobs

Use `@nestjs/bullmq` + BullMQ for work that must not block HTTP requests. In this Docker project, Redis uses the `redis` Compose hostname. Register the queue once in a shared module through validated config; do not hardcode `localhost` or duplicate queue options across publishers and consumers.

For a database state change that requires a job, persist a transactional outbox event in the same PostgreSQL transaction. Publishing directly after `save()` creates a dual-write failure window: the row can commit while enqueue fails, or a job can run before the transaction commits.

```typescript
await dataSource.transaction(async (manager) => {
  await manager.save(video);
  await manager.save(
    manager.create(VideoProcessingOutbox, {
      id: eventId,
      video_id: video.id,
      event_type: 'video.processing.requested',
      payload: { version: 1, eventId, videoId: video.id },
    }),
  );
});
```

The relay publishes after commit with a deterministic job ID, and marks the event published only after `queue.add()` succeeds:

```typescript
await queue.add('video.processing.requested', event.payload, {
  jobId: `video-processing-${event.id}`,
  attempts: config.attempts,
  backoff: { type: 'exponential', delay: config.backoffDelayMs },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
});
```

Consumers extend `WorkerHost` for `@nestjs/bullmq` and rethrow failures so BullMQ performs retries:

```typescript
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJob>): Promise<void> {
    if (job.name !== PROCESS_VIDEO_JOB) {
      throw new Error('Unsupported video processing job');
    }

    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    await this.processing.process(job.data.videoId, finalAttempt);
  }
}
```

Rules:

- Make jobs idempotent; BullMQ is at-least-once delivery, not exactly once.
- Version job payloads before incompatible changes.
- Configure bounded attempts, exponential backoff, concurrency, and completed/failed retention.
- Persist terminal domain failure only on the last attempt; intermediate failures must rethrow without pretending success.
- Claim outbox rows with leases/`SKIP LOCKED` for multiple API replicas and bound polling batches/delays.
- Use a standalone Nest application context for workers that need no HTTP server.
- Enable shutdown hooks, stop accepting jobs, await the active job up to a grace period, then force-close child processes/worker if necessary.
- Integration-test publication/deduplication and consumption/retry with real Redis and process-specific queue names. Never use `FLUSHALL`.

Reference: [NestJS Queues](https://docs.nestjs.com/techniques/queues)
