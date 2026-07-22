import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  VIDEO_PROCESSING_REQUESTED_EVENT,
  VideoProcessingOutbox,
} from './entities/video-processing-outbox.entity';
import { VideoUpload, VideoUploadStatus } from './entities/video-upload.entity';
import { Video, VideoStatus } from './entities/video.entity';
import type { VideoMetadata } from './entities/video.entity';
import {
  UploadAlreadyCompletedException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
} from './video.exceptions';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CreateDraftUploadRecord {
  videoId: string;
  channelId: string;
  publicId: string;
  title: string;
  objectKey: string;
  uploadId: string;
  fileSize: number;
  contentType: string;
  partSize: number;
  expiresAt: Date;
}

export interface VideoWithUpload {
  video: Video;
  upload: VideoUpload;
}

export interface CompleteVideoProcessingRecord {
  videoId: string;
  durationSeconds: string;
  metadata: VideoMetadata;
  playbackObjectKey: string;
  thumbnailObjectKey: string;
}

@Injectable()
export class VideoRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findChannelByUserId(userId: string): Promise<Channel | null> {
    return this.dataSource.getRepository(Channel).findOne({
      where: { user_id: userId },
    });
  }

  async findByIdOrPublicId(identifier: string): Promise<Video | null> {
    const repository = this.dataSource.getRepository(Video);
    return UUID_PATTERN.test(identifier)
      ? repository.findOne({
          where: [{ id: identifier }, { public_id: identifier }],
          relations: { channel: true },
        })
      : repository.findOne({
          where: { public_id: identifier },
          relations: { channel: true },
        });
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.dataSource.getRepository(Video).findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
  }

  async beginProcessing(videoId: string): Promise<Video | null> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Video);
      const video = await repository.findOne({
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!video) {
        return null;
      }
      if (
        video.status === VideoStatus.READY &&
        video.playback_object_key &&
        video.thumbnail_object_key
      ) {
        return video;
      }

      video.status = VideoStatus.PROCESSING;
      video.processing_error = null;
      return repository.save(video);
    });
  }

  async completeProcessing(
    input: CompleteVideoProcessingRecord,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Video);
      const video = await repository.findOne({
        where: { id: input.videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!video) {
        return;
      }

      video.duration_seconds = input.durationSeconds;
      video.metadata = input.metadata;
      video.playback_object_key = input.playbackObjectKey;
      video.thumbnail_object_key = input.thumbnailObjectKey;
      video.processing_error = null;
      video.status = VideoStatus.READY;
      await repository.save(video);
    });
  }

  async failProcessing(
    videoId: string,
    processingError: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Video);
      const video = await repository.findOne({
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!video || video.status === VideoStatus.READY) {
        return;
      }

      video.status = VideoStatus.ERROR;
      video.processing_error = processingError;
      await repository.save(video);
    });
  }

  async findUploadSession(
    videoId: string,
    uploadId: string,
  ): Promise<VideoWithUpload | null> {
    const upload = await this.dataSource.getRepository(VideoUpload).findOne({
      where: { video_id: videoId, upload_id: uploadId },
      relations: { video: { channel: true } },
    });

    return upload ? { video: upload.video, upload } : null;
  }

  async createDraftWithUpload(
    input: CreateDraftUploadRecord,
  ): Promise<VideoWithUpload> {
    return this.dataSource.transaction(async (manager) => {
      const video = await manager.save(
        manager.create(Video, {
          id: input.videoId,
          channel_id: input.channelId,
          public_id: input.publicId,
          title: input.title,
          status: VideoStatus.DRAFT,
          source_object_key: input.objectKey,
        }),
      );
      const upload = await manager.save(
        manager.create(VideoUpload, {
          video_id: video.id,
          upload_id: input.uploadId,
          object_key: input.objectKey,
          file_size: String(input.fileSize),
          content_type: input.contentType,
          part_size: input.partSize,
          status: VideoUploadStatus.INITIATED,
          expires_at: input.expiresAt,
        }),
      );

      return { video, upload };
    });
  }

  async completeUpload(
    videoId: string,
    uploadId: string,
    completedAt: Date,
  ): Promise<Video> {
    return this.dataSource.transaction(async (manager) => {
      const uploadRepository = manager.getRepository(VideoUpload);
      const upload = await uploadRepository.findOne({
        where: { video_id: videoId, upload_id: uploadId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!upload) {
        throw new UploadSessionNotFoundException();
      }

      const videoRepository = manager.getRepository(Video);
      const video = await videoRepository.findOne({
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!video) {
        throw new UploadSessionNotFoundException();
      }

      if (upload.status === VideoUploadStatus.COMPLETED) {
        return video;
      }
      if (upload.status !== VideoUploadStatus.INITIATED) {
        throw new UploadSessionNotActiveException();
      }

      upload.status = VideoUploadStatus.COMPLETED;
      upload.completed_at = completedAt;
      video.status = VideoStatus.PROCESSING;
      await uploadRepository.save(upload);
      await videoRepository.save(video);

      const outboxRepository = manager.getRepository(VideoProcessingOutbox);
      const existingEvent = await outboxRepository.findOne({
        where: {
          video_id: video.id,
          event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
        },
      });
      if (!existingEvent) {
        const eventId = randomUUID();
        await outboxRepository.save(
          outboxRepository.create({
            id: eventId,
            video_id: video.id,
            event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
            payload: { version: 1, eventId, videoId: video.id },
          }),
        );
      }

      return video;
    });
  }

  async abortUpload(videoId: string, uploadId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(VideoUpload);
      const upload = await repository.findOne({
        where: { video_id: videoId, upload_id: uploadId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!upload) {
        throw new UploadSessionNotFoundException();
      }
      if (upload.status === VideoUploadStatus.ABORTED) {
        return;
      }
      if (upload.status === VideoUploadStatus.COMPLETED) {
        throw new UploadAlreadyCompletedException();
      }

      upload.status = VideoUploadStatus.ABORTED;
      await repository.save(upload);
    });
  }
}
