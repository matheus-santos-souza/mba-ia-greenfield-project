import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type { ObjectStoragePort } from '../src/storage/object-storage.port';
import {
  OBJECT_STORAGE_PORT,
  S3_INTERNAL_CLIENT,
} from '../src/storage/storage.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const PLAYBACK = Buffer.alloc(2048, 0x42);

interface Actor {
  user: User;
  channel: Channel;
  token: string;
}

interface VideoFixture {
  id: string;
  publicId: string;
  objectKey: string;
}

describe('videos-stream', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let jwt: JwtService;
  let storage: ObjectStoragePort;
  let s3Client: S3Client;
  let throttlerStorage: ThrottlerStorageService;
  let bucket: string;
  let owner: Actor;
  let nonOwner: Actor;
  let readyVideo: VideoFixture;
  let processingVideo: VideoFixture;
  let sequence = 0;
  const createdObjectKeys = new Set<string>();
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

  beforeAll(async () => {
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
    jwt = moduleFixture.get(JwtService);
    storage = moduleFixture.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    s3Client = moduleFixture.get<S3Client>(S3_INTERNAL_CLIENT);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
  });

  beforeEach(async () => {
    await cleanupStorage();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await createActor('owner');
    nonOwner = await createActor('non-owner');
    readyVideo = await createVideo(owner, VideoStatus.READY, true);
    processingVideo = await createVideo(owner, VideoStatus.PROCESSING, false);
  });

  afterAll(async () => {
    await cleanupStorage();
    await app.close();
    restoreEnv('STORAGE_PUBLIC_ENDPOINT', originalPublicEndpoint);
  });

  it('redirecionar-stream-do-video-pronto', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${readyVideo.publicId}/stream`)
      .set('Authorization', `Bearer ${owner.token}`)
      .redirects(0)
      .expect(307);

    const location = response.headers.location;
    expect(location).toContain(`/videos/${readyVideo.id}/playback/video.mp4`);
    expect(location).toContain('X-Amz-Signature=');
    expect(response.text).toBe('');
  });

  it('servir-range-parcial-no-destino-do-stream', async () => {
    const redirect = await request(app.getHttpServer())
      .get(`/videos/${readyVideo.publicId}/stream`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Range', 'bytes=0-1023')
      .redirects(0)
      .expect(307);

    expect(redirect.text).toBe('');
    const response = await fetch(redirect.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    const body = await response.arrayBuffer();

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/2048');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(body.byteLength).toBe(1024);
  });

  it('redirecionar-download-com-attachment-publico', async () => {
    const redirect = await request(app.getHttpServer())
      .get(`/videos/${readyVideo.publicId}/download`)
      .set('Authorization', `Bearer ${owner.token}`)
      .redirects(0)
      .expect(307);

    const location = redirect.headers.location;
    expect(redirect.text).toBe('');
    expect(location).toContain('X-Amz-Signature=');

    const response = await fetch(location);
    const body = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get('content-disposition');

    expect(response.status).toBe(200);
    expect(disposition).toBe(
      `attachment; filename="${readyVideo.publicId}.mp4"`,
    );
    expect(disposition).not.toContain(readyVideo.id);
    expect(disposition).not.toContain(readyVideo.objectKey);
    expect(body).toEqual(PLAYBACK);
  });

  it('impor-autenticacao-ownership-e-readiness', async () => {
    for (const route of ['stream', 'download']) {
      const unauthorized = await request(app.getHttpServer())
        .get(`/videos/${readyVideo.publicId}/${route}`)
        .redirects(0)
        .expect(401);
      expect(unauthorized.headers).not.toHaveProperty('location');

      const forbidden = await request(app.getHttpServer())
        .get(`/videos/${readyVideo.publicId}/${route}`)
        .set('Authorization', `Bearer ${nonOwner.token}`)
        .redirects(0)
        .expect(403);
      expect(forbidden.body).toMatchObject({ error: 'VIDEO_ACCESS_DENIED' });
      expect(forbidden.headers).not.toHaveProperty('location');

      const notReady = await request(app.getHttpServer())
        .get(`/videos/${processingVideo.publicId}/${route}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .redirects(0)
        .expect(409);
      expect(notReady.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
      expect(notReady.headers).not.toHaveProperty('location');
    }
  });

  async function createActor(label: string): Promise<Actor> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `videos-stream-${label}-${suffix}@example.com`,
        password: 'hashed-password',
        is_confirmed: true,
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Videos Stream ${label} ${suffix}`,
        nickname: `videos-stream-${label}-${suffix}`,
        description: null,
        user_id: user.id,
      }),
    );
    return {
      user,
      channel,
      token: await jwt.signAsync({ sub: user.id, email: user.email }),
    };
  }

  async function createVideo(
    actor: Actor,
    status: VideoStatus,
    withPlayback: boolean,
  ): Promise<VideoFixture> {
    const suffix = ++sequence;
    const id = randomUUID();
    const publicId = `S${String(suffix).padStart(20, '0')}`;
    const objectKey = `videos/${id}/playback/video.mp4`;
    await videos.save(
      videos.create({
        id,
        channel_id: actor.channel.id,
        public_id: publicId,
        title: `Stream fixture ${suffix}`,
        status,
        source_object_key: `videos/${id}/source/original`,
        playback_object_key: withPlayback ? objectKey : null,
        thumbnail_object_key: withPlayback
          ? `videos/${id}/thumbnail.jpg`
          : null,
        duration_seconds: withPlayback ? '1.000' : null,
        metadata: withPlayback
          ? {
              format: 'mp4',
              codec: 'h264',
              width: 640,
              height: 360,
              bit_rate: 1_000_000,
              size_bytes: PLAYBACK.length,
            }
          : null,
        processing_error: null,
      }),
    );

    if (withPlayback) {
      createdObjectKeys.add(objectKey);
      await storage.uploadObject({
        objectKey,
        body: Readable.from(PLAYBACK),
        contentLength: PLAYBACK.length,
        contentType: 'video/mp4',
      });
    }

    return { id, publicId, objectKey };
  }

  async function cleanupStorage(): Promise<void> {
    await Promise.all(
      [...createdObjectKeys].map((objectKey) =>
        s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
        ),
      ),
    );
    createdObjectKeys.clear();
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
