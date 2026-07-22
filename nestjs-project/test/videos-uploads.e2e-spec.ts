import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type {
  MultipartPart,
  ObjectStoragePort,
} from '../src/storage/object-storage.port';
import { MultipartUploadNotFoundError } from '../src/storage/storage.errors';
import {
  OBJECT_STORAGE_PORT,
  S3_INTERNAL_CLIENT,
} from '../src/storage/storage.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import {
  VIDEO_PROCESSING_REQUESTED_EVENT,
  VideoProcessingOutbox,
} from '../src/videos/entities/video-processing-outbox.entity';
import {
  VideoUpload,
  VideoUploadStatus,
} from '../src/videos/entities/video-upload.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/processing/video-processing-queue.constants';

const PART_SIZE = 5 * 1024 * 1024;
const TAIL = Buffer.from('multipart-tail');

interface Actor {
  user: User;
  token: string;
}

interface TrackedUpload {
  videoId: string;
  uploadId: string;
  objectKey: string;
}

interface SignedPartResponse {
  part_number: number;
  upload_url: string;
  expires_at: string;
}

interface SignedPartsResponse {
  parts: SignedPartResponse[];
}

describe('videos-uploads', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let outbox: Repository<VideoProcessingOutbox>;
  let jwt: JwtService;
  let storage: ObjectStoragePort;
  let s3Client: S3Client;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let bucket: string;
  let sequence = 0;
  const trackedUploads: TrackedUpload[] = [];
  const originalPartSize = process.env.VIDEO_MULTIPART_PART_SIZE_BYTES;
  const originalVideoTypes = process.env.VIDEO_ALLOWED_CONTENT_TYPES;
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    process.env.VIDEO_MULTIPART_PART_SIZE_BYTES = String(PART_SIZE);
    process.env.VIDEO_ALLOWED_CONTENT_TYPES = 'video/mp4';
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    uploads = dataSource.getRepository(VideoUpload);
    outbox = dataSource.getRepository(VideoProcessingOutbox);
    jwt = moduleFixture.get(JwtService);
    storage = moduleFixture.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    s3Client = moduleFixture.get<S3Client>(S3_INTERNAL_CLIENT);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
  });

  afterAll(async () => {
    await cleanupStorage();
    await app.close();
    restoreEnv('VIDEO_MULTIPART_PART_SIZE_BYTES', originalPartSize);
    restoreEnv('VIDEO_ALLOWED_CONTENT_TYPES', originalVideoTypes);
    restoreEnv('STORAGE_PUBLIC_ENDPOINT', originalPublicEndpoint);
  });

  beforeEach(async () => {
    await cleanupStorage();
    await cleanAllTables(dataSource);
    await queue.drain(true);
    throttlerStorage.storage.clear();
  });

  async function cleanupStorage(): Promise<void> {
    for (const tracked of trackedUploads.splice(0)) {
      try {
        await storage.abortMultipartUpload({
          objectKey: tracked.objectKey,
          uploadId: tracked.uploadId,
        });
      } catch {
        // Completed and already-aborted multipart sessions are terminal.
      }
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: tracked.objectKey }),
      );
    }
  }

  async function createActor(withChannel = true): Promise<Actor> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `videos-e2e-${suffix}@example.com`,
        password: 'hashed-password',
        is_confirmed: true,
      }),
    );
    if (withChannel) {
      await channels.save(
        channels.create({
          name: `Videos E2E ${suffix}`,
          nickname: `videos-e2e-${suffix}`,
          user_id: user.id,
        }),
      );
    }
    return {
      user,
      token: await jwt.signAsync({ sub: user.id, email: user.email }),
    };
  }

  async function initiateUpload(
    actor: Actor,
    fileSize = PART_SIZE + TAIL.length,
  ): Promise<TrackedUpload> {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${actor.token}`)
      .send({
        title: 'Multipart E2E video',
        file_size: fileSize,
        content_type: 'video/mp4',
      })
      .expect(201);
    const video = await videos.findOneByOrFail({ id: response.body.video_id });
    const tracked = {
      videoId: response.body.video_id as string,
      uploadId: response.body.upload_id as string,
      objectKey: video.source_object_key,
    };
    trackedUploads.push(tracked);
    return tracked;
  }

  async function uploadSignedParts(
    actor: Actor,
    tracked: TrackedUpload,
  ): Promise<MultipartPart[]> {
    const response = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ part_numbers: [1, 2] })
      .expect(200);
    const responseBody = response.body as SignedPartsResponse;

    const bodies = [Buffer.alloc(PART_SIZE, 0x61), TAIL];
    for (const [index, part] of responseBody.parts.entries()) {
      const uploadResponse = await fetch(part.upload_url, {
        method: 'PUT',
        body: bodies[index],
      });
      expect(uploadResponse.ok).toBe(true);
    }

    return [...(await storage.listMultipartParts(tracked))];
  }

  it('iniciar-upload-multipart', async () => {
    const owner = await createActor();

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: '  Public upload title  ',
        file_size: PART_SIZE + TAIL.length,
        content_type: 'video/mp4',
      })
      .expect(201);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        'video_id',
        'public_id',
        'upload_id',
        'part_size',
        'status',
        'expires_at',
      ].sort(),
    );
    expect(response.body).toEqual({
      video_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      public_id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/),
      upload_id: expect.any(String),
      part_size: PART_SIZE,
      status: VideoStatus.DRAFT,
      expires_at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.expires_at))).toBe(false);

    const video = await videos.findOneByOrFail({ id: response.body.video_id });
    const upload = await uploads.findOneByOrFail({ video_id: video.id });
    trackedUploads.push({
      videoId: video.id,
      uploadId: upload.upload_id,
      objectKey: upload.object_key,
    });
    expect(video).toMatchObject({
      channel_id: expect.any(String),
      title: 'Public upload title',
      status: VideoStatus.DRAFT,
    });
    const channel = await channels.findOneByOrFail({ user_id: owner.user.id });
    expect(video.channel_id).toBe(channel.id);
    expect(upload.status).toBe(VideoUploadStatus.INITIATED);
    await expect(
      storage.listMultipartParts(trackedUploads[0]),
    ).resolves.toEqual([]);
  }, 30_000);

  it('retomar-upload-com-partes-autoritativas', async () => {
    const owner = await createActor();
    const tracked = await initiateUpload(owner);
    const signed = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const uploaded = await fetch(signed.body.parts[0].upload_url as string, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 0x62),
    });
    expect(uploaded.ok).toBe(true);

    const response = await request(app.getHttpServer())
      .get(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        'video_id',
        'upload_id',
        'part_size',
        'file_size',
        'status',
        'expires_at',
        'uploaded_parts',
      ].sort(),
    );
    expect(response.body.uploaded_parts).toEqual([
      {
        part_number: 1,
        etag: expect.any(String),
        size: PART_SIZE,
      },
    ]);
    expect(response.body.status).toBe(VideoUploadStatus.INITIATED);
  }, 30_000);

  it('assinar-partes-distintas', async () => {
    const owner = await createActor();
    const tracked = await initiateUpload(owner);
    const requestedAt = Date.now();

    const response = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ part_numbers: [1, 2] })
      .expect(200);
    const responseBody = response.body as SignedPartsResponse;

    expect(responseBody.parts.map((part) => part.part_number)).toEqual([1, 2]);
    expect(
      new Set(responseBody.parts.map((part) => part.part_number)).size,
    ).toBe(2);
    for (const part of responseBody.parts) {
      expect(new URL(part.upload_url).hostname).toBe('minio');
      const expiresAt = Date.parse(part.expires_at);
      expect(expiresAt).toBeGreaterThan(requestedAt);
      expect(expiresAt).toBeLessThanOrEqual(requestedAt + 16 * 60 * 1_000);
      expect(Object.keys(part).sort()).toEqual(
        ['part_number', 'upload_url', 'expires_at'].sort(),
      );
    }
  });

  it('concluir-upload-e-iniciar-processamento', async () => {
    const owner = await createActor();
    const tracked = await initiateUpload(owner);
    const authoritativeParts = await uploadSignedParts(owner, tracked);

    const response = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/complete`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        parts: authoritativeParts.map((part) => ({
          part_number: part.partNumber,
          etag: part.etag,
        })),
      })
      .expect(202);

    expect(response.body).toEqual({
      video_id: tracked.videoId,
      public_id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/),
      status: VideoStatus.PROCESSING,
    });
    expect(
      await uploads.findOneByOrFail({ video_id: tracked.videoId }),
    ).toMatchObject({ status: VideoUploadStatus.COMPLETED });
    expect(await videos.findOneByOrFail({ id: tracked.videoId })).toMatchObject(
      {
        status: VideoStatus.PROCESSING,
      },
    );
    const events = await outbox.findBy({ video_id: tracked.videoId });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe(VIDEO_PROCESSING_REQUESTED_EVENT);
  }, 30_000);

  it('abortar-upload-ativo', async () => {
    const owner = await createActor();
    const tracked = await initiateUpload(owner);

    const first = await request(app.getHttpServer())
      .delete(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);
    expect(first.text).toBe('');
    expect(
      await uploads.findOneByOrFail({ video_id: tracked.videoId }),
    ).toMatchObject({ status: VideoUploadStatus.ABORTED });
    await expect(storage.listMultipartParts(tracked)).rejects.toThrow(
      MultipartUploadNotFoundError,
    );

    const repeated = await request(app.getHttpServer())
      .delete(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);
    expect(repeated.text).toBe('');
    expect(await outbox.countBy({ video_id: tracked.videoId })).toBe(0);
  });

  it('rejeitar-payload-e-parametros-invalidos', async () => {
    const owner = await createActor();
    const invalidBody = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Missing file size', content_type: 'video/mp4' })
      .expect(400);
    expect(invalidBody.body).toMatchObject({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: expect.any(Array),
    });
    expect(await videos.count()).toBe(0);
    expect(await uploads.count()).toBe(0);

    const tracked = await initiateUpload(owner);
    const invalidParams = await request(app.getHttpServer())
      .get(`/videos/not-a-uuid/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(400);
    expect(invalidParams.body.error).toBe('VALIDATION_ERROR');

    const duplicateParts = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ part_numbers: [1, 1] })
      .expect(400);
    expect(duplicateParts.body.error).toBe('VALIDATION_ERROR');
    await expect(storage.listMultipartParts(tracked)).resolves.toEqual([]);
  });

  it('impor-autenticacao-e-ownership', async () => {
    const owner = await createActor();
    const nonOwner = await createActor(false);
    const tracked = await initiateUpload(owner);
    throttlerStorage.storage.clear();

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({ title: 'Anonymous', file_size: 1, content_type: 'video/mp4' })
      .expect(401);
    await request(app.getHttpServer())
      .get(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .send({ part_numbers: [1] })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/complete`)
      .send({ parts: [{ part_number: 1, etag: 'etag' }] })
      .expect(401);
    await request(app.getHttpServer())
      .delete(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .expect(401);

    throttlerStorage.storage.clear();
    const forbiddenInitiate = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${nonOwner.token}`)
      .send({ title: 'Forbidden', file_size: 1, content_type: 'video/mp4' })
      .expect(403);
    expect(forbiddenInitiate.body.error).toBe('VIDEO_ACCESS_DENIED');

    const forbiddenResume = await request(app.getHttpServer())
      .get(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${nonOwner.token}`)
      .expect(403);
    expect(forbiddenResume.body.error).toBe('VIDEO_ACCESS_DENIED');

    const forbiddenSign = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/parts`)
      .set('Authorization', `Bearer ${nonOwner.token}`)
      .send({ part_numbers: [1] })
      .expect(403);
    expect(forbiddenSign.body.error).toBe('VIDEO_ACCESS_DENIED');

    const forbiddenComplete = await request(app.getHttpServer())
      .post(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}/complete`)
      .set('Authorization', `Bearer ${nonOwner.token}`)
      .send({ parts: [{ part_number: 1, etag: 'etag' }] })
      .expect(403);
    expect(forbiddenComplete.body.error).toBe('VIDEO_ACCESS_DENIED');

    const forbiddenAbort = await request(app.getHttpServer())
      .delete(`/videos/${tracked.videoId}/uploads/${tracked.uploadId}`)
      .set('Authorization', `Bearer ${nonOwner.token}`)
      .expect(403);
    expect(forbiddenAbort.body.error).toBe('VIDEO_ACCESS_DENIED');

    expect(
      await uploads.findOneByOrFail({ video_id: tracked.videoId }),
    ).toMatchObject({ status: VideoUploadStatus.INITIATED });
    await expect(storage.listMultipartParts(tracked)).resolves.toEqual([]);
    expect(await outbox.countBy({ video_id: tracked.videoId })).toBe(0);
  }, 30_000);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
