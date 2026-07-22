---
paths:
  - 'nestjs-project/src/storage/**'
  - 'nestjs-project/src/config/storage.config.ts'
  - 'nestjs-project/src/videos/video-upload.service.ts'
  - 'nestjs-project/src/videos/video-delivery.service.ts'
  - 'nestjs-project/src/videos/video-upload-cleanup.service.ts'
  - 'nestjs-project/src/videos/processing/video-processing.service.ts'
description: 'S3/MinIO object-storage boundary, deterministic keys, presigned URLs, multipart safety, and error translation'
---

# S3 / MinIO Object Storage Rules

## Port Boundary

- Domain/application services inject `OBJECT_STORAGE_PORT` and depend on `ObjectStoragePort`; they never instantiate or inject `S3Client` directly.
- `StorageModule` owns both S3 clients and the concrete `S3ObjectStorageService`. It exports only the port token and `VideoStorageKeyService`.
- MinIO is the local/test implementation of the production S3-compatible contract. Do not add a filesystem branch or environment-specific storage behavior inside video services.

## Internal vs Public Endpoint

- `STORAGE_INTERNAL_ENDPOINT` is for SDK operations performed inside containers and uses `http://minio:9000`.
- `STORAGE_PUBLIC_ENDPOINT` is only for generating presigned URLs. It must be reachable by the URL consumer: normally `http://localhost:9000` for the host/browser, or `http://minio:9000` for tests fetching the URL inside `nestjs-api`.
- Never "fix" container DNS by changing internal service hosts to `localhost`.
- Keep `forcePathStyle: true` for local MinIO compatibility unless a deliberate provider migration changes this contract.

## Private Bucket and Presigning

- The bucket remains private; `minio-init` creates it idempotently and disables anonymous access.
- The API signs direct multipart `UploadPart` and short-lived `GetObject` requests; it does not proxy video bytes.
- Presigned URL TTLs are positive, configuration-driven, and scoped separately for upload parts and playback.
- Never log, persist, or return presigned URLs outside the immediate API response. They contain temporary authorization material.
- Stream/download endpoints authorize ownership and readiness before signing. Do not reveal storage existence, object keys, readiness, or signed locations to a non-owner.

## Object Keys

Generate keys only through `VideoStorageKeyService`:

```text
videos/{videoId}/source/original
videos/{videoId}/playback/video.mp4
videos/{videoId}/thumbnails/default.jpg
```

- Keys use the internal video UUID, never user-provided filenames, titles, MIME values, public IDs, path fragments, or extensions.
- Keep source, playback, and thumbnail namespaces distinct and deterministic so processing retries are idempotent.
- Public downloads use `{publicId}.mp4` only in `Content-Disposition`; never expose internal UUIDs or keys as filenames.

## Multipart Contract

- S3 `ListParts` is authoritative for uploaded part number, ETag, checksum, and size. Never trust only the client-submitted completion manifest.
- Require unique ascending part numbers in the S3 range `1..10000` and no more parts than the declared file size requires.
- Every non-final part must match the configured part size and satisfy S3's 5 MiB minimum; the sum must equal the declared file size.
- Completion and abort are retry-safe. Reconcile `NoSuchUpload` during completion with `HeadObject`; treat an already absent upload during abort/expiry cleanup as the expected terminal result.
- If persistence fails after creating a multipart upload, attempt storage compensation. If both fail, preserve both errors with `AggregateError`.

## Error Boundary and Resource Lifecycle

- Translate AWS SDK exceptions once inside `S3ObjectStorageService` into typed storage errors. Video services map typed storage failures to domain exceptions without exposing provider details.
- Do not catch unknown programming/domain errors and relabel them as storage outages.
- Validate response bodies and required metadata (`UploadId`, readable body, artifact size/type) before returning success.
- Destroy both S3 clients on module shutdown.
- Integration tests track and remove only their own object keys and multipart sessions; never delete the bucket or a broad prefix.
