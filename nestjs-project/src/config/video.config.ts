import { registerAs } from '@nestjs/config';

const bytesPerMebibyte = 1024 * 1024;

export default registerAs('video', () => ({
  maxFileSizeBytes: Number.parseInt(
    process.env.VIDEO_MAX_FILE_SIZE_BYTES ?? '10737418240',
    10,
  ),
  multipartPartSizeBytes: Number.parseInt(
    process.env.VIDEO_MULTIPART_PART_SIZE_BYTES ??
      String(100 * bytesPerMebibyte),
    10,
  ),
  uploadExpirationHours: Number.parseInt(
    process.env.VIDEO_UPLOAD_EXPIRATION_HOURS ?? '24',
    10,
  ),
  uploadCleanupIntervalMs: Number.parseInt(
    process.env.VIDEO_UPLOAD_CLEANUP_INTERVAL_MS ?? '60000',
    10,
  ),
  uploadCleanupBatchSize: Number.parseInt(
    process.env.VIDEO_UPLOAD_CLEANUP_BATCH_SIZE ?? '25',
    10,
  ),
  processingConcurrency: Number.parseInt(
    process.env.VIDEO_PROCESSING_CONCURRENCY ?? '1',
    10,
  ),
  workerShutdownGraceSeconds: Number.parseInt(
    process.env.VIDEO_WORKER_SHUTDOWN_GRACE_SECONDS ?? '30',
    10,
  ),
  processingTimeoutSeconds: Number.parseInt(
    process.env.VIDEO_PROCESSING_TIMEOUT_SECONDS ?? '900',
    10,
  ),
  ffmpegPath: process.env.FFMPEG_PATH ?? '/usr/bin/ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? '/usr/bin/ffprobe',
  allowedContentTypes: (
    process.env.VIDEO_ALLOWED_CONTENT_TYPES ?? 'video/mp4,video/quicktime'
  )
    .split(',')
    .map((contentType) => contentType.trim())
    .filter(Boolean),
}));
