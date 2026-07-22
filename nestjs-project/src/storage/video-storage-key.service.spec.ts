import { Test } from '@nestjs/testing';
import { VideoStorageKeyService } from './video-storage-key.service';

describe('VideoStorageKeyService', () => {
  let service: VideoStorageKeyService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [VideoStorageKeyService],
    }).compile();

    service = module.get(VideoStorageKeyService);
  });

  it('should build the deterministic source key', () => {
    const videoId = '3e9338ca-3614-420d-9886-9992885717a5';

    expect(service.source(videoId)).toBe(`videos/${videoId}/source/original`);
  });

  it('should build the deterministic playback key', () => {
    const videoId = '66813f95-4576-422d-870b-a97b137ed3db';

    expect(service.playback(videoId)).toBe(
      `videos/${videoId}/playback/video.mp4`,
    );
  });

  it('should build the deterministic thumbnail key', () => {
    const videoId = '387df14a-7be6-459b-bfdb-24805b92f12c';

    expect(service.thumbnail(videoId)).toBe(
      `videos/${videoId}/thumbnails/default.jpg`,
    );
  });

  it('should not accept a user filename or title when building keys', () => {
    expect(VideoStorageKeyService.prototype.source.length).toBe(1);
    expect(VideoStorageKeyService.prototype.playback.length).toBe(1);
    expect(VideoStorageKeyService.prototype.thumbnail.length).toBe(1);
  });
});
