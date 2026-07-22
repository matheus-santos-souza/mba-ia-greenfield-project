import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ObjectStoragePort } from '../../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../../storage/storage.constants';
import { VideoStorageKeyService } from '../../storage/video-storage-key.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideoRepository } from '../video.repository';
import {
  MediaProcessorPort,
  type ProcessedMedia,
} from './media-processor.port';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let repository: jest.Mocked<
    Pick<
      VideoRepository,
      'beginProcessing' | 'completeProcessing' | 'failProcessing'
    >
  >;
  let storage: jest.Mocked<
    Pick<ObjectStoragePort, 'getObject' | 'uploadObject' | 'headObject'>
  >;
  let mediaProcessor: jest.Mocked<MediaProcessorPort>;
  let directory: string;
  let playbackPath: string;
  let thumbnailPath: string;

  const video = {
    id: '11111111-1111-4111-8111-111111111111',
    status: VideoStatus.PROCESSING,
    source_object_key: 'videos/111/source/original',
    playback_object_key: null,
    thumbnail_object_key: null,
  } as Video;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'video-processing-service-'));
    playbackPath = join(directory, 'playback.mp4');
    thumbnailPath = join(directory, 'thumbnail.jpg');
    await Promise.all([
      writeFile(playbackPath, Buffer.from('playback')),
      writeFile(thumbnailPath, Buffer.from('thumbnail')),
    ]);

    repository = {
      beginProcessing: jest.fn().mockResolvedValue(video),
      completeProcessing: jest.fn().mockResolvedValue(undefined),
      failProcessing: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      getObject: jest.fn().mockResolvedValue({
        body: Readable.from(Buffer.from('source')),
      }),
      uploadObject: jest.fn().mockImplementation(async (input) => {
        for await (const chunk of input.body) {
          // Drain the real file stream used by the service boundary.
          void chunk;
        }
        return { objectKey: input.objectKey };
      }),
      headObject: jest.fn().mockResolvedValue({ contentLength: 10 }),
    };
    mediaProcessor = {
      withProcessedMedia: jest.fn().mockImplementation(
        async <T>(
          _source: Readable,
          consume: (media: ProcessedMedia) => Promise<T>,
        ): Promise<T> =>
          consume({
            durationSeconds: '2.500',
            metadata: {
              format: 'mov,mp4',
              codec: 'h264',
              width: 320,
              height: 180,
              bit_rate: 48000,
              size_bytes: 15000,
            },
            playback: {
              path: playbackPath,
              contentLength: 8,
              contentType: 'video/mp4',
            },
            thumbnail: {
              path: thumbnailPath,
              contentLength: 9,
              contentType: 'image/jpeg',
            },
          }),
      ),
      terminateActiveProcesses: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        VideoStorageKeyService,
        { provide: VideoRepository, useValue: repository },
        { provide: OBJECT_STORAGE_PORT, useValue: storage },
        { provide: MediaProcessorPort, useValue: mediaProcessor },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  afterEach(async () => {
    await module.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('short-circuits a fully ready video without reading storage', async () => {
    repository.beginProcessing.mockResolvedValue({
      ...video,
      status: VideoStatus.READY,
      playback_object_key: 'videos/111/playback/video.mp4',
      thumbnail_object_key: 'videos/111/thumbnails/default.jpg',
    });

    await expect(service.process(video.id, false)).resolves.toBeUndefined();

    expect(storage.getObject).not.toHaveBeenCalled();
    expect(mediaProcessor.withProcessedMedia).not.toHaveBeenCalled();
  });

  it('streams deterministic artifacts and atomically persists normalized media data', async () => {
    await service.process(video.id, false);

    expect(storage.uploadObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        objectKey: `videos/${video.id}/playback/video.mp4`,
        contentType: 'video/mp4',
      }),
    );
    expect(storage.uploadObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        objectKey: `videos/${video.id}/thumbnails/default.jpg`,
        contentType: 'image/jpeg',
      }),
    );
    expect(repository.completeProcessing).toHaveBeenCalledWith({
      videoId: video.id,
      durationSeconds: '2.500',
      metadata: {
        format: 'mov,mp4',
        codec: 'h264',
        width: 320,
        height: 180,
        bit_rate: 48000,
        size_bytes: 15000,
      },
      playbackObjectKey: `videos/${video.id}/playback/video.mp4`,
      thumbnailObjectKey: `videos/${video.id}/thumbnails/default.jpg`,
    });
    expect(repository.failProcessing).not.toHaveBeenCalled();
  });

  it('keeps processing state and rethrows a retryable failure', async () => {
    const failure = new Error('temporary storage failure');
    storage.getObject.mockRejectedValue(failure);

    await expect(service.process(video.id, false)).rejects.toBe(failure);

    expect(repository.failProcessing).not.toHaveBeenCalled();
    expect(repository.completeProcessing).not.toHaveBeenCalled();
  });

  it('persists a sanitized error only on the final attempt and still rethrows', async () => {
    const failure = new Error(
      'failed at http://minio:9000/private in /tmp/streamtube-video-secret/file',
    );
    storage.getObject.mockRejectedValue(failure);

    await expect(service.process(video.id, true)).rejects.toBe(failure);

    expect(repository.failProcessing).toHaveBeenCalledWith(
      video.id,
      'failed at [redacted-url] in [redacted-path]',
    );
  });
});
