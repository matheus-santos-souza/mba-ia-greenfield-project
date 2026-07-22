import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  internalEndpoint:
    process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  bucket: process.env.STORAGE_BUCKET ?? '',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  forcePathStyle: true,
  uploadPartUrlTtlSeconds: Number.parseInt(
    process.env.STORAGE_UPLOAD_PART_URL_TTL_SECONDS ?? '900',
    10,
  ),
  playbackUrlTtlSeconds: Number.parseInt(
    process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS ?? '300',
    10,
  ),
}));
