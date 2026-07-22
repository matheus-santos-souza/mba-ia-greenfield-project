---
paths:
  - 'nestjs-project/Dockerfile.dev'
  - 'nestjs-project/src/config/video.config.ts'
  - 'nestjs-project/src/videos/processing/ffmpeg-media-processor.ts'
  - 'nestjs-project/src/videos/processing/media-processor.port.ts'
  - 'nestjs-project/src/videos/processing/video-processing.service.ts'
  - 'nestjs-project/src/videos/processing/video-worker-shutdown.service.ts'
description: 'Safe FFmpeg/FFprobe execution, canonical artifacts, bounded diagnostics, temporary files, and process shutdown'
---

# FFmpeg / FFprobe Media Processing Rules

## Process Execution

- Invoke FFmpeg/FFprobe with `spawn(command, args, { stdio: [...] })` or an equivalent argument-array API. Never build a shell command from file paths, metadata, or environment values.
- Include `-nostdin` so a worker cannot hang waiting for interactive input, and enforce `VIDEO_PROCESSING_TIMEOUT_SECONDS` per command.
- Track every active child process. Remove it from the set in `finally`, including spawn errors, non-zero exits, output-limit failures, and timeouts.
- Bound captured stdout/stderr. Do not place raw stderr, URLs, credentials, source paths, or temporary paths in public/persisted error messages.

## Temporary Media Lifecycle

- Create a unique directory under `os.tmpdir()` for each processing attempt.
- Stream the source into the directory; do not buffer an entire video in memory.
- Delete the directory recursively in `finally` after the consumer callback finishes or fails.
- Processed paths are valid only inside `withProcessedMedia()`'s callback. Never return a path for later asynchronous use after cleanup.

## Canonical Output

- Probe the source first and reject missing/invalid video streams or non-finite metadata.
- Canonical playback is MP4 with H.264 video, `yuv420p`, optional AAC audio, and `+faststart`.
- Generate one JPEG thumbnail at the normalized midpoint.
- Verify each artifact is a non-empty file and pass exact content length/type to object storage.
- Persist normalized duration plus bounded structured metadata (`format`, `codec`, width, height, bit rate, source size); never persist the entire ffprobe document.

## Port and Shutdown

- Application processing depends on `MediaProcessorPort`; the FFmpeg implementation owns child-process details.
- Inject `MEDIA_PROCESS_SPAWNER` so process control/error paths can be unit-tested without invoking binaries.
- The dev/worker image must contain both `ffmpeg` and `ffprobe`; paths remain validated configuration.
- Graceful shutdown first stops BullMQ intake. Kill active media processes only after the configured worker grace period expires.

## Tests

- Unit tests verify exact argument arrays, timeout/kill behavior, stdout/stderr limits, sanitization, active-process tracking, and temp cleanup through the injected spawner.
- Integration tests use the real container binaries and assert a probeable H.264/AAC fast-start MP4, JPEG magic bytes, normalized metadata, and cleanup.
- A mocked successful process is not evidence that generated media is compatible; keep the real FFmpeg integration test.
