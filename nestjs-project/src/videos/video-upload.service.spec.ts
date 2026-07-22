import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import {
  MultipartUploadNotFoundError,
  ObjectStorageUnavailableError,
} from '../storage/storage.errors';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { VideoStorageKeyService } from '../storage/video-storage-key.service';
import { VideoUpload, VideoUploadStatus } from './entities/video-upload.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PublicVideoIdService } from './public-video-id.service';
import {
  InvalidUploadPartsException,
  StorageUnavailableException,
  UploadAlreadyCompletedException,
  UploadSessionExpiredException,
  VideoAccessDeniedException,
} from './video.exceptions';
import { VideoOwnershipService } from './video-ownership.service';
import { VideoUploadService } from './video-upload.service';
import { VideoRepository, type VideoWithUpload } from './video.repository';

const PART_SIZE = 5 * 1024 * 1024;
const PUBLIC_ID = 'P'.repeat(21);

function makeSession(
  status: VideoUploadStatus = VideoUploadStatus.INITIATED,
  overrides: Partial<VideoUpload> = {},
): VideoWithUpload {
  const video = Object.assign(new Video(), {
    id: '019b67cf-6c2d-7c17-b0a7-c3ea172ca25f',
    channel_id: '019b67cf-6c2d-7c17-b0a7-c3ea172ca260',
    public_id: PUBLIC_ID,
    title: 'Video title',
    status:
      status === VideoUploadStatus.COMPLETED
        ? VideoStatus.PROCESSING
        : VideoStatus.DRAFT,
    source_object_key:
      'videos/019b67cf-6c2d-7c17-b0a7-c3ea172ca25f/source/original',
  });
  const upload = Object.assign(new VideoUpload(), {
    id: '019b67cf-6c2d-7c17-b0a7-c3ea172ca261',
    video_id: video.id,
    upload_id: 'storage-upload-id',
    object_key: video.source_object_key,
    file_size: String(PART_SIZE + 3),
    content_type: 'video/mp4',
    part_size: PART_SIZE,
    status,
    expires_at: new Date(Date.now() + 60_000),
    completed_at: status === VideoUploadStatus.COMPLETED ? new Date() : null,
    ...overrides,
  });
  upload.video = video;
  video.upload = upload;
  return { video, upload };
}

describe('VideoUploadService', () => {
  let module: TestingModule;
  let service: VideoUploadService;
  let videos: {
    createDraftWithUpload: jest.Mock;
    completeUpload: jest.Mock;
    abortUpload: jest.Mock;
  };
  let ownership: {
    requireChannel: jest.Mock;
    requireUpload: jest.Mock;
  };
  let publicIds: { persistWithRetry: jest.Mock };
  let storage: jest.Mocked<ObjectStoragePort>;

  beforeEach(async () => {
    const session = makeSession();
    videos = {
      createDraftWithUpload: jest.fn().mockResolvedValue(session),
      completeUpload: jest
        .fn()
        .mockResolvedValue(
          Object.assign(session.video, { status: VideoStatus.PROCESSING }),
        ),
      abortUpload: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      requireChannel: jest.fn().mockResolvedValue({
        id: session.video.channel_id,
        user_id: 'owner-id',
      }),
      requireUpload: jest.fn().mockResolvedValue(session),
    };
    publicIds = {
      persistWithRetry: jest.fn(
        async (persist: (publicId: string) => Promise<VideoWithUpload>) =>
          persist(PUBLIC_ID),
      ),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue({
        objectKey: session.upload.object_key,
        uploadId: session.upload.upload_id,
      }),
      signMultipartParts: jest.fn(),
      listMultipartParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      getObject: jest.fn(),
      uploadObject: jest.fn(),
      headObject: jest.fn(),
      presignGetObject: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        VideoUploadService,
        { provide: VideoRepository, useValue: videos },
        { provide: VideoOwnershipService, useValue: ownership },
        { provide: PublicVideoIdService, useValue: publicIds },
        {
          provide: VideoStorageKeyService,
          useValue: {
            source: jest.fn(
              (videoId: string) => `videos/${videoId}/source/original`,
            ),
          },
        },
        { provide: OBJECT_STORAGE_PORT, useValue: storage },
        {
          provide: videoConfig.KEY,
          useValue: {
            maxFileSizeBytes: 10_737_418_240,
            multipartPartSizeBytes: PART_SIZE,
            uploadExpirationHours: 24,
            allowedContentTypes: ['video/mp4'],
          },
        },
        {
          provide: storageConfig.KEY,
          useValue: { uploadPartUrlTtlSeconds: 900 },
        },
      ],
    }).compile();
    service = module.get(VideoUploadService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('initiates storage and persists the draft session before returning', async () => {
    const result = await service.initiate({
      userId: 'owner-id',
      title: '  My upload  ',
      fileSize: PART_SIZE + 3,
      contentType: 'video/mp4',
    });

    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'video/mp4',
        metadata: {
          'declared-file-size': String(PART_SIZE + 3),
          'declared-content-type': 'video/mp4',
        },
      }),
    );
    expect(videos.createDraftWithUpload).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My upload', publicId: PUBLIC_ID }),
    );
    expect(result).toMatchObject({
      public_id: PUBLIC_ID,
      upload_id: 'storage-upload-id',
      status: VideoStatus.DRAFT,
    });
  });

  it('does not contact storage when channel ownership is denied', async () => {
    ownership.requireChannel.mockRejectedValue(
      new VideoAccessDeniedException(),
    );

    await expect(
      service.initiate({
        userId: 'no-channel',
        title: 'Denied',
        fileSize: 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('maps storage initiation failures to STORAGE_UNAVAILABLE', async () => {
    storage.createMultipartUpload.mockRejectedValue(
      new ObjectStorageUnavailableError('create', 'offline'),
    );

    await expect(
      service.initiate({
        userId: 'owner-id',
        title: 'Unavailable',
        fileSize: 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(StorageUnavailableException);
  });

  it('resumes from the authoritative sorted storage part list', async () => {
    storage.listMultipartParts.mockResolvedValue([
      { partNumber: 2, etag: 'etag-2', size: 3 },
      { partNumber: 1, etag: 'etag-1', size: PART_SIZE },
    ]);

    const result = await service.resume(
      'owner-id',
      makeSession().video.id,
      'storage-upload-id',
    );

    expect(result.uploaded_parts.map((part) => part.part_number)).toEqual([
      1, 2,
    ]);
  });

  it('rejects an expired active session before a storage call', async () => {
    ownership.requireUpload.mockResolvedValue(
      makeSession(VideoUploadStatus.INITIATED, {
        expires_at: new Date(Date.now() - 1),
      }),
    );

    await expect(
      service.signParts('owner-id', makeSession().video.id, 'upload', [1]),
    ).rejects.toBeInstanceOf(UploadSessionExpiredException);
    expect(storage.signMultipartParts).not.toHaveBeenCalled();
  });

  it('signs only distinct parts within the expected file part count', async () => {
    storage.signMultipartParts.mockResolvedValue([
      { partNumber: 1, url: 'http://minio/part-1' },
      { partNumber: 2, url: 'http://minio/part-2' },
    ]);

    await expect(
      service.signParts('owner-id', makeSession().video.id, 'upload', [1, 1]),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      service.signParts('owner-id', makeSession().video.id, 'upload', [3]),
    ).rejects.toBeInstanceOf(RangeError);

    const result = await service.signParts(
      'owner-id',
      makeSession().video.id,
      'upload',
      [1, 2],
    );
    expect(result.parts).toHaveLength(2);
    expect(storage.signMultipartParts).toHaveBeenCalledTimes(1);
  });

  it('rejects submitted completion parts that differ from ListParts', async () => {
    storage.listMultipartParts.mockResolvedValue([
      { partNumber: 1, etag: 'storage-etag', size: PART_SIZE },
      { partNumber: 2, etag: 'tail', size: 3 },
    ]);

    await expect(
      service.complete('owner-id', makeSession().video.id, 'upload', [
        { part_number: 1, etag: 'client-etag' },
        { part_number: 2, etag: 'tail' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videos.completeUpload).not.toHaveBeenCalled();
  });

  it('completes authoritative parts and persists processing state', async () => {
    const listed = [
      { partNumber: 1, etag: 'etag-1', size: PART_SIZE },
      { partNumber: 2, etag: 'etag-2', size: 3 },
    ];
    storage.listMultipartParts.mockResolvedValue(listed);
    storage.completeMultipartUpload.mockResolvedValue({
      objectKey: makeSession().upload.object_key,
    });

    const result = await service.complete(
      'owner-id',
      makeSession().video.id,
      'upload',
      [
        { part_number: 1, etag: 'etag-1' },
        { part_number: 2, etag: 'etag-2' },
      ],
    );

    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ parts: listed }),
    );
    expect(videos.completeUpload).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });

  it('returns an already completed session without another side effect', async () => {
    ownership.requireUpload.mockResolvedValue(
      makeSession(VideoUploadStatus.COMPLETED),
    );

    const result = await service.complete(
      'owner-id',
      makeSession().video.id,
      'upload',
      [{ part_number: 1, etag: 'ignored' }],
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(storage.listMultipartParts).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videos.completeUpload).not.toHaveBeenCalled();
  });

  it('reconciles a storage-completed retry through HeadObject', async () => {
    storage.listMultipartParts.mockRejectedValue(
      new MultipartUploadNotFoundError('list', 'already completed'),
    );
    storage.headObject.mockResolvedValue({
      contentLength: PART_SIZE + 3,
      contentType: 'video/mp4',
    });

    await expect(
      service.complete('owner-id', makeSession().video.id, 'upload', [
        { part_number: 1, etag: 'etag-1' },
      ]),
    ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    expect(videos.completeUpload).toHaveBeenCalledTimes(1);
  });

  it('aborts once and treats a repeated aborted session as a no-op', async () => {
    ownership.requireUpload
      .mockResolvedValueOnce(makeSession(VideoUploadStatus.INITIATED))
      .mockResolvedValueOnce(makeSession(VideoUploadStatus.ABORTED));

    await service.abort('owner-id', makeSession().video.id, 'upload');
    await service.abort('owner-id', makeSession().video.id, 'upload');

    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(videos.abortUpload).toHaveBeenCalledTimes(1);
  });

  it('refuses to abort a completed upload', async () => {
    ownership.requireUpload.mockResolvedValue(
      makeSession(VideoUploadStatus.COMPLETED),
    );

    await expect(
      service.abort('owner-id', makeSession().video.id, 'upload'),
    ).rejects.toBeInstanceOf(UploadAlreadyCompletedException);
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });
});
