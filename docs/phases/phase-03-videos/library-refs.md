---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1091.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-20T23:13:05-04:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1091.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-20T23:13:05-04:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-20T23:13:05-04:00"
  "bullmq":
    version: "^5.80.9"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-20T23:13:05-04:00"
  "nanoid":
    version: "^5.1.16"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-20T23:13:05-04:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-20 23:08:43.240042604 -0400"
---

# Library References — phase-03-videos

### @aws-sdk/client-s3

Planned version: `^3.1091.0` (current registry release at fetch time: `3.1091.0`; requires Node `>=20.0.0`).

- Import `S3Client` and the individual commands from `@aws-sdk/client-s3`; the v3 SDK is command-based and fully typed.
- Configure MinIO with a custom `endpoint`, explicit `region` and credentials, and `forcePathStyle: true`. Inside Compose, the internal endpoint must use the `minio` service name.
- The multipart control plane uses `CreateMultipartUploadCommand`, `UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, and `AbortMultipartUploadCommand`.
- Persist the returned `UploadId`; completion requires the ordered `{ PartNumber, ETag }` list. Preserve checksum fields when enabled by the client/storage contract.
- Use `GetObjectCommand` for source/playback/download reads. Range delivery and `206 Partial Content` must be verified against the real MinIO adapter rather than inferred from a filesystem fake.

```ts
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: storageConfig.internalEndpoint,
  forcePathStyle: true,
  region: storageConfig.region,
  credentials: storageConfig.credentials,
});
```

### @aws-sdk/s3-request-presigner

Planned version: `^3.1091.0` (current registry release at fetch time: `3.1091.0`; requires Node `>=20.0.0`).

- Generate URLs with `getSignedUrl(s3Client, command, { expiresIn })`; the documented default expiry is 900 seconds, so the application should set and validate its chosen TTL explicitly.
- Presign an `UploadPartCommand` containing `Bucket`, `Key`, `UploadId`, and `PartNumber` for each multipart part.
- Presign a `GetObjectCommand` for playback. For downloads, set the response content-disposition override on the command before signing.
- The client endpoint participates in the generated URL. Browser-facing URLs therefore need a routable external storage endpoint; Docker service names are valid only inside the Compose network.
- CORS, `Range`, `Content-Range`, and expiry behavior remain real MinIO integration-test obligations.

```ts
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const uploadPartUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: storageConfig.uploadPartUrlTtlSeconds },
);

const playbackUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: storageConfig.playbackUrlTtlSeconds },
);
```

### @nestjs/bullmq

Planned version: `^11.0.4` (current registry release at fetch time: `11.0.4`).

- Configure the Redis connection with `BullModule.forRootAsync()` and register the named processing queue with `BullModule.registerQueue()` or `registerQueueAsync()`.
- Inject the producer queue with `@InjectQueue(queueName)`; keep job payload types and job names in shared backend contracts.
- Implement the consumer with `@Processor(queueName)` and `WorkerHost.process(job)`. Worker options supplied by the processor integration are forwarded to BullMQ's `Worker`.
- The dedicated `video-worker` can bootstrap a Nest application context without HTTP while reusing configuration, database, storage, and logging providers.
- Nest shutdown hooks close registered workers and queues; the container still needs graceful `SIGTERM` handling and enough termination time for active FFmpeg work.

```ts
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJob>): Promise<void> {
    // Delegate orchestration and FFmpeg execution to focused services.
  }
}
```

### bullmq

Planned version: `^5.80.9` (current registry release at fetch time: `5.80.9`; requires Node `>=12.22.0`).

- Supply a deterministic `jobId` when the outbox relay enqueues work. Duplicate suppression applies while the existing job remains in Redis; aggressive `removeOnComplete`/`removeOnFail` can therefore weaken broker-level deduplication.
- Configure bounded `attempts` with exponential `backoff`; terminal failure remains a persisted application state, not merely a queue record.
- Use low per-worker concurrency for CPU-heavy FFmpeg jobs and scale with additional worker containers when needed.
- `QueueEvents` exposes completed, failed, delayed, stalled, and deduplicated events for operational visibility.
- Call `Worker.close()` during graceful shutdown so active work can finish and avoid unnecessary stalled-job recovery.

```ts
await videoQueue.add('process-video', payload, {
  jobId: `video-processing:${payload.videoId}:${payload.processingVersion}`,
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: false,
  removeOnFail: false,
});
```

### nanoid

Planned version: `^5.1.16`. NanoID `6.0.0` was deliberately not selected because its engine range (`^22 || ^24 || >=26`) excludes the project's Node 25 runtime; NanoID `5.1.16` supports Node `^18 || >=20`.

- `nanoid()` returns the default 21-character, URL-safe identifier chosen by TD-09.
- Shortening the size increases collision probability; retain the default length.
- Generation remains probabilistic. A PostgreSQL unique constraint is authoritative, and draft creation must retry only the public-ID collision case.
- NanoID 5 uses the Web Crypto API and exposes a synchronous ESM import. Verify the compiled NestJS/Jest module path under Node 25 during implementation.

```ts
import { nanoid } from 'nanoid';

const publicId = nanoid();
```
