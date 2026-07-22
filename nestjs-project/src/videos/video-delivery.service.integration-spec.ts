import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import {
  OBJECT_STORAGE_PORT,
  S3_INTERNAL_CLIENT,
} from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoRepository } from './video.repository';

const PLAYBACK_URL_TTL_SECONDS = 37;
const ARTIFACT = Buffer.alloc(2048, 0x42);

interface ReadyVideoFixture {
  ownerId: string;
  publicId: string;
  objectKey: string;
}

describe('VideoDeliveryService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let service: VideoDeliveryService;
  let storage: ObjectStoragePort;
  let s3Client: S3Client;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let bucket: string;
  let sequence = 0;
  const createdObjectKeys = new Set<string>();
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;
  const originalPlaybackTtl = process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS;

  beforeAll(async () => {
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';
    process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS = String(
      PLAYBACK_URL_TTL_SECONDS,
    );

    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        VideoRepository,
        VideoDeliveryService,
      ],
    }).compile();

    service = module.get(VideoDeliveryService);
    storage = module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    s3Client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
    await dataSource.destroy();
    restoreEnv('STORAGE_PUBLIC_ENDPOINT', originalPublicEndpoint);
    restoreEnv('STORAGE_PLAYBACK_URL_TTL_SECONDS', originalPlaybackTtl);
  });

  it('should authorize through PostgreSQL and serve a signed byte range from MinIO', async () => {
    const fixture = await createReadyVideo();

    const signedUrl = await service.createStreamRedirect(
      fixture.ownerId,
      fixture.publicId,
    );
    const parsedUrl = new URL(signedUrl);
    expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe(
      String(PLAYBACK_URL_TTL_SECONDS),
    );

    const response = await fetch(signedUrl, {
      headers: { Range: 'bytes=0-1023' },
    });
    const bytes = await response.arrayBuffer();

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/2048');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(bytes.byteLength).toBe(1024);
  });

  it('should serve the canonical MP4 with an attachment disposition', async () => {
    const fixture = await createReadyVideo();

    const signedUrl = await service.createDownloadRedirect(
      fixture.ownerId,
      fixture.publicId,
    );
    const parsedUrl = new URL(signedUrl);
    const expectedDisposition = `attachment; filename="${fixture.publicId}.mp4"`;

    expect(parsedUrl.searchParams.get('response-content-disposition')).toBe(
      expectedDisposition,
    );

    const response = await fetch(signedUrl);
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      expectedDisposition,
    );
    expect(bytes).toEqual(ARTIFACT);
  });

  async function createReadyVideo(): Promise<ReadyVideoFixture> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `video_delivery_owner_${suffix}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Video Delivery Owner ${suffix}`,
        nickname: `video_delivery_${suffix}`,
        description: null,
        user_id: user.id,
      }),
    );
    const publicId = `D${String(suffix).padStart(20, '0')}`;
    const videoId = randomUUID();
    const objectKey = `videos/${videoId}/playback/video.mp4`;
    await videos.save(
      videos.create({
        id: videoId,
        channel_id: channel.id,
        public_id: publicId,
        title: `Ready video ${suffix}`,
        status: VideoStatus.READY,
        source_object_key: `videos/${videoId}/source/original`,
        playback_object_key: objectKey,
        thumbnail_object_key: `videos/${videoId}/thumbnail.jpg`,
        duration_seconds: '1.000',
        metadata: {
          format: 'mp4',
          codec: 'h264',
          width: 640,
          height: 360,
          bit_rate: 1_000_000,
          size_bytes: ARTIFACT.length,
        },
        processing_error: null,
      }),
    );

    createdObjectKeys.add(objectKey);
    await storage.uploadObject({
      objectKey,
      body: Readable.from(ARTIFACT),
      contentLength: ARTIFACT.length,
      contentType: 'video/mp4',
    });

    return { ownerId: user.id, publicId, objectKey };
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
