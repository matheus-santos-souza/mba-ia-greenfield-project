import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
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
import {
  VIDEO_PROCESSING_REQUESTED_EVENT,
  VideoProcessingOutbox,
} from './entities/video-processing-outbox.entity';
import { VideoUpload, VideoUploadStatus } from './entities/video-upload.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PublicVideoIdService } from './public-video-id.service';
import {
  UploadAlreadyCompletedException,
  VideoAccessDeniedException,
} from './video.exceptions';
import { VideoOwnershipService } from './video-ownership.service';
import {
  type CompleteVideoUploadPart,
  VideoUploadService,
} from './video-upload.service';
import { VideoRepository } from './video.repository';

const PART_SIZE = 5 * 1024 * 1024;
const TAIL = Buffer.from('multipart-tail');

interface InitiatedUpload {
  ownerId: string;
  videoId: string;
  uploadId: string;
  objectKey: string;
}

describe('VideoUploadService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let service: VideoUploadService;
  let storage: ObjectStoragePort;
  let s3Client: S3Client;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let outbox: Repository<VideoProcessingOutbox>;
  let bucket: string;
  let sequence = 0;
  const initiatedUploads: InitiatedUpload[] = [];
  const originalVideoPartSize = process.env.VIDEO_MULTIPART_PART_SIZE_BYTES;
  const originalVideoTypes = process.env.VIDEO_ALLOWED_CONTENT_TYPES;
  const originalPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    process.env.VIDEO_MULTIPART_PART_SIZE_BYTES = String(PART_SIZE);
    process.env.VIDEO_ALLOWED_CONTENT_TYPES = 'video/mp4';
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';

    dataSource = createTestDataSource([
      User,
      Channel,
      Video,
      VideoUpload,
      VideoProcessingOutbox,
    ]);
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
        VideoRepository,
        VideoOwnershipService,
        PublicVideoIdService,
        VideoUploadService,
      ],
    }).compile();

    service = module.get(VideoUploadService);
    storage = module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    s3Client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    uploads = dataSource.getRepository(VideoUpload);
    outbox = dataSource.getRepository(VideoProcessingOutbox);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
    restoreEnv('VIDEO_MULTIPART_PART_SIZE_BYTES', originalVideoPartSize);
    restoreEnv('VIDEO_ALLOWED_CONTENT_TYPES', originalVideoTypes);
    restoreEnv('STORAGE_PUBLIC_ENDPOINT', originalPublicEndpoint);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    initiatedUploads.length = 0;
  });

  afterEach(async () => {
    for (const initiated of initiatedUploads) {
      try {
        await storage.abortMultipartUpload({
          objectKey: initiated.objectKey,
          uploadId: initiated.uploadId,
        });
      } catch {
        // Completed and already-aborted multipart sessions no longer exist.
      }
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: initiated.objectKey,
        }),
      );
    }
  });

  async function createOwner(): Promise<{ user: User; channel: Channel }> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `video_upload_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Video Upload Owner ${suffix}`,
        nickname: `video-upload-owner-${suffix}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function initiate(
    fileSize = PART_SIZE + TAIL.length,
  ): Promise<InitiatedUpload> {
    const { user } = await createOwner();
    const result = await service.initiate({
      userId: user.id,
      title: 'Multipart integration video',
      fileSize,
      contentType: 'video/mp4',
    });
    const video = await videos.findOneByOrFail({ id: result.video_id });
    const initiated = {
      ownerId: user.id,
      videoId: result.video_id,
      uploadId: result.upload_id,
      objectKey: video.source_object_key,
    };
    initiatedUploads.push(initiated);
    return initiated;
  }

  async function uploadParts(
    initiated: InitiatedUpload,
  ): Promise<CompleteVideoUploadPart[]> {
    const signed = await service.signParts(
      initiated.ownerId,
      initiated.videoId,
      initiated.uploadId,
      [1, 2],
    );
    const bodies = [Buffer.alloc(PART_SIZE, 0x61), TAIL];
    for (const [index, part] of signed.parts.entries()) {
      const response = await fetch(part.upload_url, {
        method: 'PUT',
        body: bodies[index],
      });
      expect(response.ok).toBe(true);
    }
    const resumed = await service.resume(
      initiated.ownerId,
      initiated.videoId,
      initiated.uploadId,
    );
    return resumed.uploaded_parts.map((part) => ({
      part_number: part.part_number,
      etag: part.etag,
    }));
  }

  it('persists a draft and initiated session before returning control', async () => {
    const initiated = await initiate();
    const video = await videos.findOneByOrFail({ id: initiated.videoId });
    const upload = await uploads.findOneByOrFail({
      video_id: initiated.videoId,
    });

    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      public_id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/),
      source_object_key: `videos/${video.id}/source/original`,
    });
    expect(upload).toMatchObject({
      upload_id: initiated.uploadId,
      object_key: video.source_object_key,
      status: VideoUploadStatus.INITIATED,
      part_size: PART_SIZE,
    });
  });

  it('completes real MinIO parts and creates exactly one outbox event', async () => {
    const initiated = await initiate();
    const parts = await uploadParts(initiated);

    const first = await service.complete(
      initiated.ownerId,
      initiated.videoId,
      initiated.uploadId,
      parts,
    );
    const second = await service.complete(
      initiated.ownerId,
      initiated.videoId,
      initiated.uploadId,
      parts,
    );

    expect(first).toEqual(second);
    expect(first.status).toBe(VideoStatus.PROCESSING);
    await expect(
      storage.headObject(initiated.objectKey),
    ).resolves.toMatchObject({
      contentLength: PART_SIZE + TAIL.length,
      contentType: 'video/mp4',
    });
    expect(
      await outbox.countBy({
        video_id: initiated.videoId,
        event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
      }),
    ).toBe(1);
    await expect(
      uploads.findOneByOrFail({ video_id: initiated.videoId }),
    ).resolves.toMatchObject({ status: VideoUploadStatus.COMPLETED });
  }, 30_000);

  it('reconciles when storage completed before the database transaction', async () => {
    const initiated = await initiate();
    const submittedParts = await uploadParts(initiated);
    const listedParts = await storage.listMultipartParts({
      objectKey: initiated.objectKey,
      uploadId: initiated.uploadId,
    });
    await storage.completeMultipartUpload({
      objectKey: initiated.objectKey,
      uploadId: initiated.uploadId,
      parts: listedParts,
    });

    await expect(
      service.complete(
        initiated.ownerId,
        initiated.videoId,
        initiated.uploadId,
        submittedParts,
      ),
    ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    expect(await outbox.countBy({ video_id: initiated.videoId })).toBe(1);
  }, 30_000);

  it('aborts idempotently and refuses an abort after completion', async () => {
    const aborted = await initiate(1);
    await service.abort(aborted.ownerId, aborted.videoId, aborted.uploadId);
    await service.abort(aborted.ownerId, aborted.videoId, aborted.uploadId);
    await expect(
      uploads.findOneByOrFail({ video_id: aborted.videoId }),
    ).resolves.toMatchObject({ status: VideoUploadStatus.ABORTED });

    const completed = await initiate();
    const parts = await uploadParts(completed);
    await service.complete(
      completed.ownerId,
      completed.videoId,
      completed.uploadId,
      parts,
    );
    await expect(
      service.abort(completed.ownerId, completed.videoId, completed.uploadId),
    ).rejects.toBeInstanceOf(UploadAlreadyCompletedException);
  }, 30_000);

  it('enforces ownership through the channel user relation', async () => {
    const initiated = await initiate(1);
    const { user: stranger } = await createOwner();

    await expect(
      service.resume(stranger.id, initiated.videoId, initiated.uploadId),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
