import { Inject, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { ObjectStoragePort } from '../../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../../storage/storage.constants';
import { VideoStorageKeyService } from '../../storage/video-storage-key.service';
import { VideoStatus } from '../entities/video.entity';
import { VideoRepository } from '../video.repository';
import { MediaProcessorPort } from './media-processor.port';

const PROCESSING_ERROR_MAX_LENGTH = 1_000;

export class VideoProcessingNotFoundError extends Error {
  constructor() {
    super('Video processing target was not found');
    this.name = 'VideoProcessingNotFoundError';
  }
}

@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly videos: VideoRepository,
    @Inject(OBJECT_STORAGE_PORT)
    private readonly storage: ObjectStoragePort,
    private readonly storageKeys: VideoStorageKeyService,
    private readonly mediaProcessor: MediaProcessorPort,
  ) {}

  async process(videoId: string, finalAttempt: boolean): Promise<void> {
    const video = await this.videos.beginProcessing(videoId);
    if (!video) {
      throw new VideoProcessingNotFoundError();
    }
    if (
      video.status === VideoStatus.READY &&
      video.playback_object_key &&
      video.thumbnail_object_key
    ) {
      return;
    }

    try {
      const source = await this.storage.getObject({
        objectKey: video.source_object_key,
      });
      const playbackObjectKey = this.storageKeys.playback(video.id);
      const thumbnailObjectKey = this.storageKeys.thumbnail(video.id);

      await this.mediaProcessor.withProcessedMedia(
        source.body,
        async (media) => {
          await this.storage.uploadObject({
            objectKey: playbackObjectKey,
            body: createReadStream(media.playback.path),
            contentLength: media.playback.contentLength,
            contentType: media.playback.contentType,
          });
          await this.storage.uploadObject({
            objectKey: thumbnailObjectKey,
            body: createReadStream(media.thumbnail.path),
            contentLength: media.thumbnail.contentLength,
            contentType: media.thumbnail.contentType,
          });

          const [playback, thumbnail] = await Promise.all([
            this.storage.headObject(playbackObjectKey),
            this.storage.headObject(thumbnailObjectKey),
          ]);
          if (!playback.contentLength || !thumbnail.contentLength) {
            throw new Error('Processed media artifacts are unavailable');
          }

          await this.videos.completeProcessing({
            videoId: video.id,
            durationSeconds: media.durationSeconds,
            metadata: media.metadata,
            playbackObjectKey,
            thumbnailObjectKey,
          });
        },
      );
    } catch (error) {
      if (finalAttempt) {
        await this.videos.failProcessing(video.id, this.sanitizeError(error));
      }
      throw error;
    }
  }

  private sanitizeError(error: unknown): string {
    const raw =
      error instanceof Error ? error.message : 'Unknown processing error';
    return raw
      .replace(/https?:\/\/\S+/gi, '[redacted-url]')
      .replace(/\/tmp\/\S+/g, '[redacted-path]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PROCESSING_ERROR_MAX_LENGTH);
  }
}
