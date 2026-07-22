import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { VideoUpload } from './entities/video-upload.entity';
import { VideoUploadCleanupService } from './video-upload-cleanup.service';
import { VideoUploadRepository } from './video-upload.repository';

@Module({
  imports: [TypeOrmModule.forFeature([VideoUpload]), StorageModule],
  providers: [VideoUploadRepository, VideoUploadCleanupService],
})
export class VideoUploadCleanupModule {}
