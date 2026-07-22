---
paths:
  - 'nestjs-project/**/*.service.ts'
description: 'Service layer error handling — errors must always propagate to upper layers'
---

# Service Error Handling Rules

## Never Swallow Errors

Services must never catch an error and silently ignore it. Every error must either:
1. **Propagate naturally** — don't catch it at all, let it bubble up
2. **Be re-thrown** — catch to add context or transform, then re-throw

A `try/catch` that logs and returns `null`, `undefined`, `false`, or an empty value instead of throwing is a silent failure. This hides bugs and makes debugging extremely difficult.

## Bad: swallowing the error

```typescript
async findById(id: string): Promise<User | null> {
  try {
    return await this.userRepository.findOneByOrFail({ id });
  } catch (error) {
    this.logger.error('User not found', error);
    return null; // caller has no idea something went wrong
  }
}
```

## Good: let it propagate or re-throw with context

```typescript
async findById(id: string): Promise<User> {
  const user = await this.userRepository.findOneBy({ id });
  if (!user) {
    throw new EntityNotFoundException('User', id);
  }
  return user;
}
```

## Good: catch, enrich, re-throw

```typescript
async createChannel(dto: CreateChannelDto): Promise<Channel> {
  try {
    return await this.channelRepository.save(dto);
  } catch (error) {
    if (error.code === '23505') {
      throw new DuplicateEntityException('Channel', 'name');
    }
    throw error; // unknown errors propagate as-is
  }
}
```

## The Rule

### Request lifecycle (services invocados por controllers)

- `catch` blocks must always end with a `throw` — either the original error or a more specific one
- The only exception is when the catch is intentionally converting an error into a valid domain result (e.g., `findOneBy` returning `null` is not an error — a `try/catch` that swallows `findOneByOrFail` is)
- Throw domain exceptions (custom `Error` subclasses) — never throw NestJS HTTP exceptions (`NotFoundException`, `ConflictException`, etc.) from services. Services must not be aware of the transport layer. Exception filters are responsible for mapping domain exceptions to HTTP responses
- Logging inside a catch is fine, but logging is not a substitute for throwing

### Background tasks, event handlers e cron jobs

- In these contexts, rethrowing would crash the process. `catch` blocks should log the error and optionally queue for retry or send to a dead letter queue
- These are the **only** contexts where catch-and-log without rethrowing is acceptable
- Distinguish the long-running loop from one attempt. The outer cleanup/outbox polling loop may catch, sanitize, log, and continue after its delay; `cleanupOnce()`, `relayOnce()`, queue processors, and processing services must still return an explicit result or throw so retry/state transitions remain observable.
- BullMQ processors must rethrow failures so BullMQ applies configured attempts/backoff. Persist `error` only on the terminal attempt; swallowing an intermediate failure incorrectly marks the job successful.
- Never log presigned URLs, object-storage credentials, raw FFmpeg stderr, temporary paths, or unbounded external error strings. Persist/log bounded sanitized categories or messages.
