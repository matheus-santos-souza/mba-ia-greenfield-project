import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('db'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_INTERNAL_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_BUCKET: Joi.string().required(),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_UPLOAD_PART_URL_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(900),
  STORAGE_PLAYBACK_URL_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(300),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_PROCESSING_QUEUE: Joi.string().default('video-processing'),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().integer().positive().default(3),
  VIDEO_PROCESSING_BACKOFF_DELAY_MS: Joi.number()
    .integer()
    .positive()
    .default(1000),
  VIDEO_MAX_FILE_SIZE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(10_737_418_240)
    .default(10_737_418_240),
  VIDEO_MULTIPART_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5_242_880)
    .max(5_368_709_120)
    .default(104_857_600),
  VIDEO_UPLOAD_EXPIRATION_HOURS: Joi.number().integer().positive().default(24),
  VIDEO_UPLOAD_CLEANUP_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(60_000),
  VIDEO_UPLOAD_CLEANUP_BATCH_SIZE: Joi.number()
    .integer()
    .positive()
    .max(1_000)
    .default(25),
  VIDEO_PROCESSING_CONCURRENCY: Joi.number().integer().positive().default(1),
  VIDEO_WORKER_SHUTDOWN_GRACE_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(30),
  VIDEO_PROCESSING_TIMEOUT_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(900),
  FFMPEG_PATH: Joi.string().min(1).default('/usr/bin/ffmpeg'),
  FFPROBE_PATH: Joi.string().min(1).default('/usr/bin/ffprobe'),
  VIDEO_ALLOWED_CONTENT_TYPES: Joi.string().default(
    'video/mp4,video/quicktime',
  ),
});
