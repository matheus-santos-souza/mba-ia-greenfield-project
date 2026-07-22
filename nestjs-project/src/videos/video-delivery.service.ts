import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { ObjectStorageError } from '../storage/storage.errors';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { VideoStatus } from './entities/video.entity';
import type { Video } from './entities/video.entity';
import {
  StorageUnavailableException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import { VideoRepository } from './video.repository';

@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videos: VideoRepository,
    @Inject(OBJECT_STORAGE_PORT)
    private readonly storage: ObjectStoragePort,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
  ) {}

  async createStreamRedirect(
    userId: string,
    publicId: string,
  ): Promise<string> {
    const video = await this.requireReadyOwnedVideo(userId, publicId);
    return this.presignPlayback(video);
  }

  async createDownloadRedirect(
    userId: string,
    publicId: string,
  ): Promise<string> {
    const video = await this.requireReadyOwnedVideo(userId, publicId);
    return this.presignPlayback(
      video,
      `attachment; filename="${video.public_id}.mp4"`,
    );
  }

  private async requireReadyOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video & { playback_object_key: string }> {
    const video = await this.videos.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }
    if (
      video.status !== VideoStatus.READY ||
      video.playback_object_key === null
    ) {
      throw new VideoNotReadyException();
    }
    return video as Video & { playback_object_key: string };
  }

  private async presignPlayback(
    video: Video & { playback_object_key: string },
    responseContentDisposition?: string,
  ): Promise<string> {
    try {
      return await this.storage.presignGetObject({
        objectKey: video.playback_object_key,
        expiresInSeconds: this.storageSettings.playbackUrlTtlSeconds,
        ...(responseContentDisposition !== undefined && {
          responseContentDisposition,
        }),
      });
    } catch (error) {
      if (error instanceof ObjectStorageError) {
        throw new StorageUnavailableException();
      }
      throw error;
    }
  }
}
