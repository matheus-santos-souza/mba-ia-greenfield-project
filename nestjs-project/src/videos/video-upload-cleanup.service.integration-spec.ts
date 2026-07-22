import { randomUUID } from 'node:crypto';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { MultipartUploadNotFoundError } from '../storage/storage.errors';
import { StorageModule } from '../storage/storage.module';
import { S3ObjectStorageService } from '../storage/s3-object-storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoUpload, VideoUploadStatus } from './entities/video-upload.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadCleanupService } from './video-upload-cleanup.service';
import { VideoUploadRepository } from './video-upload.repository';

const PART_SIZE = 5 * 1024 * 1024;

interface StoredMultipartUpload {
  videoId: string;
  uploadId: string;
  objectKey: string;
}

describe('VideoUploadCleanupService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let service: VideoUploadCleanupService;
  let repository: VideoUploadRepository;
  let storage: ObjectStoragePort;
  let config: ConfigType<typeof videoConfig>;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let sequence = 0;
  const multipartUploads: StoredMultipartUpload[] = [];
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;
  const originalCleanupBatchSize = process.env.VIDEO_UPLOAD_CLEANUP_BATCH_SIZE;

  beforeAll(async () => {
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';
    process.env.VIDEO_UPLOAD_CLEANUP_BATCH_SIZE = '25';

    dataSource = createTestDataSource([User, Channel, Video, VideoUpload]);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        VideoUploadRepository,
        VideoUploadCleanupService,
      ],
    }).compile();

    service = module.get(VideoUploadCleanupService);
    repository = module.get(VideoUploadRepository);
    storage = module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    config = module.get<ConfigType<typeof videoConfig>>(videoConfig.KEY);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    uploads = dataSource.getRepository(VideoUpload);
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
    restoreEnv('STORAGE_PUBLIC_ENDPOINT', originalPublicEndpoint);
    restoreEnv('VIDEO_UPLOAD_CLEANUP_BATCH_SIZE', originalCleanupBatchSize);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    multipartUploads.length = 0;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const upload of multipartUploads) {
      try {
        await storage.abortMultipartUpload({
          objectKey: upload.objectKey,
          uploadId: upload.uploadId,
        });
      } catch {
        // Completed cleanup removes the multipart session from MinIO.
      }
    }
  });

  async function createMultipartUpload(
    expiresAt: Date,
  ): Promise<StoredMultipartUpload> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `cleanup_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Cleanup Owner ${suffix}`,
        nickname: `cleanup-owner-${suffix}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    const objectKey = `videos/${videoId}/source/original`;
    const multipart = await storage.createMultipartUpload({
      objectKey,
      contentType: 'video/mp4',
    });
    await videos.save(
      videos.create({
        id: videoId,
        channel_id: channel.id,
        public_id: randomUUID().replaceAll('-', '').slice(0, 21),
        title: `Cleanup video ${suffix}`,
        status: VideoStatus.DRAFT,
        source_object_key: objectKey,
      }),
    );
    await uploads.save(
      uploads.create({
        video_id: videoId,
        upload_id: multipart.uploadId,
        object_key: objectKey,
        file_size: String(PART_SIZE),
        content_type: 'video/mp4',
        part_size: PART_SIZE,
        status: VideoUploadStatus.INITIATED,
        expires_at: expiresAt,
      }),
    );

    const signed = await storage.signMultipartParts({
      objectKey,
      uploadId: multipart.uploadId,
      partNumbers: [1],
    });
    const response = await fetch(signed[0].url, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 0x61),
    });
    expect(response.ok).toBe(true);

    const result = {
      videoId,
      uploadId: multipart.uploadId,
      objectKey,
    };
    multipartUploads.push(result);
    return result;
  }

  it('aborts only expired sessions and removes their uploaded parts', async () => {
    const now = new Date('2031-01-01T00:00:00.000Z');
    const expired = await createMultipartUpload(
      new Date('2030-12-31T23:59:59.000Z'),
    );
    const active = await createMultipartUpload(
      new Date('2031-01-01T00:00:01.000Z'),
    );

    await expect(service.cleanupOnce(now)).resolves.toEqual({
      claimed: 1,
      aborted: 1,
      failed: 0,
    });

    await expect(
      storage.listMultipartParts({
        objectKey: expired.objectKey,
        uploadId: expired.uploadId,
      }),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
    await expect(
      storage.listMultipartParts({
        objectKey: active.objectKey,
        uploadId: active.uploadId,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      uploads.findOneByOrFail({ video_id: expired.videoId }),
    ).resolves.toMatchObject({ status: VideoUploadStatus.ABORTED });
    await expect(
      uploads.findOneByOrFail({ video_id: active.videoId }),
    ).resolves.toMatchObject({ status: VideoUploadStatus.INITIATED });
  });

  it('uses skip-locked claims so concurrent cleaners do not abort the same session', async () => {
    const now = new Date('2031-01-01T00:00:00.000Z');
    await createMultipartUpload(new Date('2030-12-31T23:59:59.000Z'));

    const storageService = module.get(S3ObjectStorageService);
    let signalEntered: () => void = () => undefined;
    let releaseAbort: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const abortSpy = jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockImplementation(async (input) => {
        signalEntered();
        await released;
        await S3ObjectStorageService.prototype.abortMultipartUpload.call(
          storageService,
          input,
        );
      });
    const secondService = new VideoUploadCleanupService(
      repository,
      storage,
      config,
    );

    const firstCleanup = service.cleanupOnce(now);
    await entered;
    const secondCleanup = secondService.cleanupOnce(now);
    const race = await Promise.race([
      secondCleanup.then((result) => ({ completed: true as const, result })),
      new Promise<{ completed: false }>((resolve) => {
        setTimeout(() => resolve({ completed: false }), 500);
      }),
    ]);
    releaseAbort();

    expect(race.completed).toBe(true);
    if (race.completed) {
      expect(race.result).toEqual({ claimed: 0, aborted: 0, failed: 0 });
    }
    await expect(firstCleanup).resolves.toEqual({
      claimed: 1,
      aborted: 1,
      failed: 0,
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
