import { envValidationSchema } from './env.validation';
import storageConfig from './storage.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_BUCKET: 'streamtube-media',
  STORAGE_ACCESS_KEY_ID: 'access-key',
  STORAGE_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — media infrastructure', () => {
  const originalInternalEndpoint = process.env.STORAGE_INTERNAL_ENDPOINT;
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

  afterEach(() => {
    if (originalInternalEndpoint === undefined) {
      delete process.env.STORAGE_INTERNAL_ENDPOINT;
    } else {
      process.env.STORAGE_INTERNAL_ENDPOINT = originalInternalEndpoint;
    }

    if (originalPublicEndpoint === undefined) {
      delete process.env.STORAGE_PUBLIC_ENDPOINT;
    } else {
      process.env.STORAGE_PUBLIC_ENDPOINT = originalPublicEndpoint;
    }
  });

  it('should coerce numeric values and apply media defaults', () => {
    const { value, error } = validate({
      REDIS_PORT: '6380',
      STORAGE_UPLOAD_PART_URL_TTL_SECONDS: '1200',
      VIDEO_PROCESSING_CONCURRENCY: '2',
    });

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6380,
      STORAGE_INTERNAL_ENDPOINT: 'http://minio:9000',
      STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
      STORAGE_UPLOAD_PART_URL_TTL_SECONDS: 1200,
      STORAGE_PLAYBACK_URL_TTL_SECONDS: 300,
      VIDEO_MAX_FILE_SIZE_BYTES: 10_737_418_240,
      VIDEO_MULTIPART_PART_SIZE_BYTES: 104_857_600,
      VIDEO_UPLOAD_EXPIRATION_HOURS: 24,
      VIDEO_PROCESSING_CONCURRENCY: 2,
      FFMPEG_PATH: '/usr/bin/ffmpeg',
      FFPROBE_PATH: '/usr/bin/ffprobe',
    });
  });

  it.each([
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
  ])('should reject missing %s', (key) => {
    const { error } = validate({ [key]: undefined });

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it.each([
    'STORAGE_UPLOAD_PART_URL_TTL_SECONDS',
    'STORAGE_PLAYBACK_URL_TTL_SECONDS',
  ])('should reject non-positive %s', (key) => {
    const { error } = validate({ [key]: '0' });

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a video size limit above 10 GiB', () => {
    const { error } = validate({
      VIDEO_MAX_FILE_SIZE_BYTES: String(10_737_418_241),
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_MAX_FILE_SIZE_BYTES');
  });

  it('should keep server-side and browser-facing storage endpoints separate', () => {
    process.env.STORAGE_INTERNAL_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://host.docker.internal:9000';

    const config = storageConfig();

    expect(config.internalEndpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://host.docker.internal:9000');
  });
});
