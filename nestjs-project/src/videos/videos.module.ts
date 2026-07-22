import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutboxRelay } from './processing/video-processing-outbox-relay';
import { VideoProcessingOutboxRepository } from './processing/video-processing-outbox.repository';
import { VideoProcessingQueueModule } from './processing/video-processing-queue.module';
import { PublicVideoIdService } from './public-video-id.service';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoOwnershipService } from './video-ownership.service';
import { VideoUploadService } from './video-upload.service';
import { VideoRepository } from './video.repository';
import { VideosController } from './videos.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoUpload, VideoProcessingOutbox]),
    ChannelsModule,
    StorageModule,
    VideoProcessingQueueModule,
  ],
  controllers: [VideosController],
  providers: [
    VideoRepository,
    VideoOwnershipService,
    VideoDeliveryService,
    PublicVideoIdService,
    VideoUploadService,
    VideoProcessingOutboxRepository,
    VideoProcessingOutboxRelay,
  ],
  exports: [VideoRepository, VideoOwnershipService, VideoUploadService],
})
export class VideosModule {}
