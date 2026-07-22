import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import {
  MultipartUploadNotFoundError,
  ObjectStorageUnavailableError,
} from '../storage/storage.errors';
import { VideoUploadCleanupService } from './video-upload-cleanup.service';
import {
  type ExpiredVideoUpload,
  VideoUploadRepository,
} from './video-upload.repository';

type VideoUploadRepositoryMock = jest.Mocked<
  Pick<VideoUploadRepository, 'processExpiredBatch'>
>;
type ObjectStorageMock = jest.Mocked<
  Pick<ObjectStoragePort, 'abortMultipartUpload'>
>;

describe('VideoUploadCleanupService', () => {
  const config = {
    maxFileSizeBytes: 10_737_418_240,
    multipartPartSizeBytes: 100 * 1024 * 1024,
    uploadExpirationHours: 24,
    uploadCleanupIntervalMs: 1_000,
    uploadCleanupBatchSize: 25,
    processingConcurrency: 1,
    workerShutdownGraceSeconds: 30,
    processingTimeoutSeconds: 900,
    ffmpegPath: '/usr/bin/ffmpeg',
    ffprobePath: '/usr/bin/ffprobe',
    allowedContentTypes: ['video/mp4'],
  } satisfies ConfigType<typeof videoConfig>;
  const expiredUpload: ExpiredVideoUpload = {
    id: '10000000-0000-4000-8000-000000000001',
    videoId: '20000000-0000-4000-8000-000000000002',
    uploadId: 'multipart-upload-id',
    objectKey: 'videos/20000000-0000-4000-8000-000000000002/source/original',
  };

  let repository: VideoUploadRepositoryMock;
  let storage: ObjectStorageMock;
  let service: VideoUploadCleanupService;

  beforeEach(async () => {
    repository = { processExpiredBatch: jest.fn() };
    storage = { abortMultipartUpload: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadCleanupService,
        { provide: VideoUploadRepository, useValue: repository },
        { provide: OBJECT_STORAGE_PORT, useValue: storage },
        { provide: videoConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideoUploadCleanupService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('requests only the configured expired batch and persists after storage abort', async () => {
    const order: string[] = [];
    const now = new Date('2031-01-01T00:00:00.000Z');
    repository.processExpiredBatch.mockImplementation(
      async (_expiredAt, _limit, processor) => {
        const shouldPersist = await processor(expiredUpload);
        if (shouldPersist) {
          order.push('persist');
        }
        return { claimed: 1, aborted: shouldPersist ? 1 : 0 };
      },
    );
    storage.abortMultipartUpload.mockImplementation(async () => {
      order.push('storage');
    });

    await expect(service.cleanupOnce(now)).resolves.toEqual({
      claimed: 1,
      aborted: 1,
      failed: 0,
    });

    expect(repository.processExpiredBatch).toHaveBeenCalledWith(
      now,
      config.uploadCleanupBatchSize,
      expect.any(Function),
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      objectKey: expiredUpload.objectKey,
      uploadId: expiredUpload.uploadId,
    });
    expect(order).toEqual(['storage', 'persist']);
  });

  it('keeps a session eligible and logs identifiers when storage is unavailable', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.processExpiredBatch.mockImplementation(
      async (_expiredAt, _limit, processor) => {
        const shouldPersist = await processor(expiredUpload);
        return { claimed: 1, aborted: shouldPersist ? 1 : 0 };
      },
    );
    storage.abortMultipartUpload.mockRejectedValue(
      new ObjectStorageUnavailableError(
        'abort multipart upload',
        'storage unavailable',
      ),
    );

    await expect(service.cleanupOnce()).resolves.toEqual({
      claimed: 1,
      aborted: 0,
      failed: 1,
    });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(`videoId=${expiredUpload.videoId}`),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(`uploadId=${expiredUpload.uploadId}`),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('category=ObjectStorageUnavailableError'),
    );
  });

  it('reconciles an already absent multipart upload as aborted', async () => {
    repository.processExpiredBatch.mockImplementation(
      async (_expiredAt, _limit, processor) => {
        const shouldPersist = await processor(expiredUpload);
        return { claimed: 1, aborted: shouldPersist ? 1 : 0 };
      },
    );
    storage.abortMultipartUpload.mockRejectedValue(
      new MultipartUploadNotFoundError(
        'abort multipart upload',
        'upload absent',
      ),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(service.cleanupOnce()).resolves.toEqual({
      claimed: 1,
      aborted: 1,
      failed: 0,
    });
  });

  it('applies exponential backoff after consecutive failed iterations', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.processExpiredBatch.mockRejectedValue(
      new Error('database unavailable'),
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1_999);
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(3);

    await service.beforeApplicationShutdown();
  });

  it('does not overlap loops and waits for active cleanup during shutdown', async () => {
    let finishBatch: (result: {
      claimed: number;
      aborted: number;
    }) => void = () => undefined;
    repository.processExpiredBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBatch = resolve;
        }),
    );

    service.onApplicationBootstrap();
    service.onApplicationBootstrap();
    await Promise.resolve();
    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(1);

    const shutdown = service.beforeApplicationShutdown();
    finishBatch({ claimed: 0, aborted: 0 });
    await shutdown;

    expect(repository.processExpiredBatch).toHaveBeenCalledTimes(1);
  });
});
