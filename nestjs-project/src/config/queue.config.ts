import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redis: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  videoProcessingQueue:
    process.env.VIDEO_PROCESSING_QUEUE ?? 'video-processing',
  attempts: Number.parseInt(process.env.VIDEO_PROCESSING_ATTEMPTS ?? '3', 10),
  backoffDelayMs: Number.parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_DELAY_MS ?? '1000',
    10,
  ),
}));
