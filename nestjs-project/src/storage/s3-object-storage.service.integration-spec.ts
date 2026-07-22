import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import type { ObjectStoragePort } from './object-storage.port';
import { MultipartUploadNotFoundError } from './storage.errors';
import { OBJECT_STORAGE_PORT, S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';

const FIVE_MEBIBYTES = 5 * 1024 * 1024;

describe('S3ObjectStorageService (integration)', () => {
  let module: TestingModule;
  let storage: ObjectStoragePort;
  let s3Client: S3Client;
  let bucket: string;
  const createdObjectKeys = new Set<string>();
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storage = module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    s3Client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
  });

  afterEach(async () => {
    await Promise.all(
      [...createdObjectKeys].map((objectKey) =>
        s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
        ),
      ),
    );
    createdObjectKeys.clear();
  });

  afterAll(async () => {
    await module.close();

    if (originalPublicEndpoint === undefined) {
      delete process.env.STORAGE_PUBLIC_ENDPOINT;
    } else {
      process.env.STORAGE_PUBLIC_ENDPOINT = originalPublicEndpoint;
    }
  });

  it('should upload listed parts through signed URLs and complete the exact object', async () => {
    const objectKey = `integration/storage/${randomUUID()}/source/original`;
    const firstPart = Buffer.alloc(FIVE_MEBIBYTES, 0x61);
    const secondPart = Buffer.from('multipart-tail');
    const expectedHash = createHash('sha256')
      .update(firstPart)
      .update(secondPart)
      .digest('hex');
    createdObjectKeys.add(objectKey);

    const multipart = await storage.createMultipartUpload({
      objectKey,
      contentType: 'video/mp4',
    });
    const signedParts = await storage.signMultipartParts({
      ...multipart,
      partNumbers: [1, 2],
    });

    for (const [index, signedPart] of signedParts.entries()) {
      const response = await fetch(signedPart.url, {
        method: 'PUT',
        body: index === 0 ? firstPart : secondPart,
      });
      expect(response.ok).toBe(true);
    }

    const parts = await storage.listMultipartParts(multipart);
    expect(parts.map(({ partNumber }) => partNumber)).toEqual([1, 2]);
    expect(parts.every(({ etag }) => etag.length > 0)).toBe(true);

    await storage.completeMultipartUpload({ ...multipart, parts });

    const storedObject = await storage.getObject({ objectKey });
    const actualHash = createHash('sha256');
    let actualLength = 0;

    for await (const chunk of storedObject.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualHash.update(bytes);
      actualLength += bytes.length;
    }

    expect(actualLength).toBe(firstPart.length + secondPart.length);
    expect(actualHash.digest('hex')).toBe(expectedHash);
  }, 30_000);

  it('should abort an active upload and prevent it from being completed', async () => {
    const objectKey = `integration/storage/${randomUUID()}/aborted`;
    const multipart = await storage.createMultipartUpload({
      objectKey,
      contentType: 'video/mp4',
    });
    const [signedPart] = await storage.signMultipartParts({
      ...multipart,
      partNumbers: [1],
    });
    const uploadResponse = await fetch(signedPart.url, {
      method: 'PUT',
      body: Buffer.from('pending-part'),
    });
    expect(uploadResponse.ok).toBe(true);

    const parts = await storage.listMultipartParts(multipart);
    expect(parts).toHaveLength(1);

    await storage.abortMultipartUpload(multipart);

    await expect(storage.listMultipartParts(multipart)).rejects.toThrow(
      MultipartUploadNotFoundError,
    );
    await expect(
      storage.completeMultipartUpload({ ...multipart, parts }),
    ).rejects.toThrow(MultipartUploadNotFoundError);
  });

  it('should stream an artifact, inspect it and serve a signed byte range', async () => {
    const objectKey = `integration/storage/${randomUUID()}/playback/video.mp4`;
    const artifact = Buffer.alloc(2048, 0x42);
    createdObjectKeys.add(objectKey);

    await storage.uploadObject({
      objectKey,
      body: Readable.from(artifact),
      contentLength: artifact.length,
      contentType: 'video/mp4',
    });

    const metadata = await storage.headObject(objectKey);
    expect(metadata).toEqual(
      expect.objectContaining({
        contentLength: artifact.length,
        contentType: 'video/mp4',
        etag: expect.any(String),
      }),
    );

    const url = await storage.presignGetObject({
      objectKey,
      range: 'bytes=0-1023',
    });
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
    });
    const bytes = await response.arrayBuffer();

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/2048');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(bytes.byteLength).toBe(1024);
  });
});
