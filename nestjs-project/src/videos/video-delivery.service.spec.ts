import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { ObjectStorageUnavailableError } from '../storage/storage.errors';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import {
  StorageUnavailableException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import { VideoRepository } from './video.repository';

const OWNER_ID = '019b67cf-6c2d-7c17-b0a7-c3ea172ca260';
const PUBLIC_ID = 'P'.repeat(21);
const PLAYBACK_OBJECT_KEY =
  'videos/019b67cf-6c2d-7c17-b0a7-c3ea172ca25f/playback/video.mp4';
const PLAYBACK_URL_TTL_SECONDS = 300;

function makeVideo(
  overrides: Partial<Video> = {},
): Video & { channel: Channel } {
  const channel = Object.assign(new Channel(), {
    id: '019b67cf-6c2d-7c17-b0a7-c3ea172ca261',
    user_id: OWNER_ID,
  });
  return Object.assign(new Video(), {
    id: '019b67cf-6c2d-7c17-b0a7-c3ea172ca25f',
    channel_id: channel.id,
    channel,
    public_id: PUBLIC_ID,
    title: 'Ready video',
    status: VideoStatus.READY,
    source_object_key:
      'videos/019b67cf-6c2d-7c17-b0a7-c3ea172ca25f/source/original',
    playback_object_key: PLAYBACK_OBJECT_KEY,
    ...overrides,
  });
}

function createStorageMock(): jest.Mocked<ObjectStoragePort> {
  return {
    createMultipartUpload: jest.fn(),
    signMultipartParts: jest.fn(),
    listMultipartParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getObject: jest.fn(),
    uploadObject: jest.fn(),
    headObject: jest.fn(),
    presignGetObject: jest.fn(),
  };
}

describe('VideoDeliveryService', () => {
  let module: TestingModule;
  let service: VideoDeliveryService;
  let videos: { findByPublicId: jest.Mock };
  let storage: jest.Mocked<ObjectStoragePort>;

  beforeEach(async () => {
    videos = { findByPublicId: jest.fn().mockResolvedValue(makeVideo()) };
    storage = createStorageMock();
    storage.presignGetObject.mockResolvedValue('http://storage/signed');

    module = await Test.createTestingModule({
      providers: [
        VideoDeliveryService,
        { provide: VideoRepository, useValue: videos },
        { provide: OBJECT_STORAGE_PORT, useValue: storage },
        {
          provide: storageConfig.KEY,
          useValue: { playbackUrlTtlSeconds: PLAYBACK_URL_TTL_SECONDS },
        },
      ],
    }).compile();

    service = module.get(VideoDeliveryService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should reject an unknown public id before calling storage', async () => {
    videos.findByPublicId.mockResolvedValue(null);

    await expect(
      service.createStreamRedirect(OWNER_ID, PUBLIC_ID),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    expect(storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('should reject a non-owner before revealing readiness or calling storage', async () => {
    videos.findByPublicId.mockResolvedValue(
      makeVideo({
        status: VideoStatus.PROCESSING,
        channel: Object.assign(new Channel(), { user_id: 'another-user' }),
      }),
    );

    await expect(
      service.createStreamRedirect(OWNER_ID, PUBLIC_ID),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    expect(storage.presignGetObject).not.toHaveBeenCalled();
  });

  it.each([
    ['processing status', { status: VideoStatus.PROCESSING }],
    ['missing playback artifact', { playback_object_key: null }],
  ])('should reject a video with %s', async (_case, overrides) => {
    videos.findByPublicId.mockResolvedValue(makeVideo(overrides));

    await expect(
      service.createStreamRedirect(OWNER_ID, PUBLIC_ID),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
    expect(storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('should sign the canonical playback object for streaming', async () => {
    await expect(
      service.createStreamRedirect(OWNER_ID, PUBLIC_ID),
    ).resolves.toBe('http://storage/signed');

    expect(videos.findByPublicId).toHaveBeenCalledWith(PUBLIC_ID);
    expect(storage.presignGetObject).toHaveBeenCalledWith({
      objectKey: PLAYBACK_OBJECT_KEY,
      expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
    });
  });

  it('should sign the canonical playback object with a safe download filename', async () => {
    await expect(
      service.createDownloadRedirect(OWNER_ID, PUBLIC_ID),
    ).resolves.toBe('http://storage/signed');

    expect(storage.presignGetObject).toHaveBeenCalledWith({
      objectKey: PLAYBACK_OBJECT_KEY,
      expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
      responseContentDisposition: `attachment; filename="${PUBLIC_ID}.mp4"`,
    });
  });

  it('should map storage signing failures without exposing storage details', async () => {
    storage.presignGetObject.mockRejectedValue(
      new ObjectStorageUnavailableError(
        'sign get object',
        `could not sign ${PLAYBACK_OBJECT_KEY} with secret credential`,
      ),
    );

    const result = service.createStreamRedirect(OWNER_ID, PUBLIC_ID);
    await expect(result).rejects.toBeInstanceOf(StorageUnavailableException);
    await expect(result).rejects.toMatchObject({
      message: 'Object storage is unavailable',
    });
  });
});
