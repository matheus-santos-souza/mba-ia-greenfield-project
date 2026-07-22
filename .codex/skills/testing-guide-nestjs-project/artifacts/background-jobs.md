> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Background Jobs, Relays, Cleanup Loops, and Workers

Phase 03 has three background behaviors: the API-side outbox relay, expired multipart cleanup, and the standalone BullMQ video worker.

## Layer assignment

| Concern | Unit | Integration |
|---|---|---|
| polling loop does not overlap and wakes on shutdown | fake timers/mocked `*Once()` boundary | — |
| backoff, terminal-attempt decision, error sanitization | mocked ports/repositories | — |
| outbox claim + publish + mark/reschedule | branch logic as needed | real PostgreSQL + Redis/BullMQ |
| queue delivery, attempts, job state, deduplication | — | real Redis/BullMQ |
| cleanup claim + S3 abort | failure/retry branches | real PostgreSQL + MinIO |
| full video processing outcome | retry/idempotency branches | PostgreSQL + Redis + MinIO + FFmpeg/FFprobe |
| standalone worker DI and shutdown | module compilation + forced-timeout branch | real module init/close when wiring is the contract |

## Queue isolation

- Use a process-specific physical queue name for integration suites.
- `obliterate({ force: true })` only that queue before/after cases.
- E2E uses the configured application queue and `drain(true)` between cases.
- Never use `FLUSHALL`.

## Required assertions

- deterministic `jobId` deduplicates republished outbox events;
- `published_at` is written only after enqueue success;
- failed relay attempts persist bounded diagnostics and later availability;
- processor failures are rethrown so BullMQ retries;
- video remains `processing` before the final failed attempt and becomes `error` only at exhaustion;
- a fully ready video performs no storage or FFmpeg work;
- shutdown closes intake, waits for the active attempt, and force-kills media processes only after the configured grace period.

Close resources in order: worker, isolated queue cleanup/close, Nest module/application, standalone DataSource. Do not leave timers or Redis handles open.
