> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External Adapters (S3 and FFmpeg/FFprobe)

Adapters need unit tests for owned translation/control logic and integration tests for the real protocol or artifact contract.

## S3ObjectStorageService

Unit/module coverage:

- DI exports the port rather than concrete clients;
- invalid part numbers/order are rejected before an SDK call;
- SDK exceptions map to the correct typed storage error;
- both clients are destroyed on module shutdown.

Real MinIO integration coverage:

- upload multipart parts through presigned URLs, then list and complete them;
- abort removes the multipart session;
- put/get/head preserve bytes, length, and content type;
- signed `Range` GET returns `206`, `Content-Range`, and `Accept-Ranges`;
- signed download sets safe attachment disposition;
- tracked objects and active multipart sessions are cleaned after each test.

Set `STORAGE_PUBLIC_ENDPOINT` to the internal MinIO endpoint only when the containerized Jest process follows its own URLs, and restore it in teardown.

## FfmpegMediaProcessor

Unit coverage with injected `MEDIA_PROCESS_SPAWNER`:

- exact argument arrays (no shell), `-nostdin`, H.264/AAC fast-start, midpoint JPEG;
- spawn/non-zero/timeout/output-limit failures;
- bounded sanitized diagnostics and active-process tracking;
- temporary-directory cleanup on success and failure.

Real binary integration coverage:

- generate a small input fixture with FFmpeg;
- probe canonical output and assert H.264, `yuv420p`, optional AAC, and `moov` before `mdat`;
- assert JPEG magic bytes, duration, dimensions, bitrate/size metadata;
- remove fixture/output directories.

The full worker integration test is still required: isolated adapter tests do not prove the PostgreSQL → Redis → MinIO → FFmpeg → MinIO → PostgreSQL workflow.
