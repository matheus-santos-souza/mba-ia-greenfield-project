import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VideoUpload, VideoUploadStatus } from './entities/video-upload.entity';

export interface ExpiredVideoUpload {
  id: string;
  videoId: string;
  uploadId: string;
  objectKey: string;
}

export interface ExpiredUploadBatchResult {
  claimed: number;
  aborted: number;
}

export type ExpiredUploadProcessor = (
  upload: ExpiredVideoUpload,
) => Promise<boolean>;

@Injectable()
export class VideoUploadRepository {
  constructor(private readonly dataSource: DataSource) {}

  async processExpiredBatch(
    expiredAt: Date,
    limit: number,
    processor: ExpiredUploadProcessor,
  ): Promise<ExpiredUploadBatchResult> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(VideoUpload);
      const uploads = await repository
        .createQueryBuilder('upload')
        .where('upload.status = :status', {
          status: VideoUploadStatus.INITIATED,
        })
        .andWhere('upload.expires_at <= :expiredAt', { expiredAt })
        .orderBy('upload.expires_at', 'ASC')
        .addOrderBy('upload.id', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      let aborted = 0;
      for (const upload of uploads) {
        const shouldMarkAborted = await processor({
          id: upload.id,
          videoId: upload.video_id,
          uploadId: upload.upload_id,
          objectKey: upload.object_key,
        });

        if (!shouldMarkAborted) {
          continue;
        }

        upload.status = VideoUploadStatus.ABORTED;
        await repository.save(upload);
        aborted += 1;
      }

      return { claimed: uploads.length, aborted };
    });
  }
}
