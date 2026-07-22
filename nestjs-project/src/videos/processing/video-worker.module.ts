import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { envValidationSchema } from '../../config/env.validation';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../../users/users.module';
import { VideoProcessingOutbox } from '../entities/video-processing-outbox.entity';
import { VideoUpload } from '../entities/video-upload.entity';
import { Video } from '../entities/video.entity';
import { VideoRepository } from '../video.repository';
import {
  FfmpegMediaProcessor,
  MEDIA_PROCESS_SPAWNER,
  spawnMediaProcess,
} from './ffmpeg-media-processor';
import { MediaProcessorPort } from './media-processor.port';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';
import { VideoWorkerShutdownService } from './video-worker-shutdown.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (config: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        database: config.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video, VideoUpload, VideoProcessingOutbox]),
    UsersModule,
    StorageModule,
    VideoProcessingQueueModule,
  ],
  providers: [
    VideoRepository,
    FfmpegMediaProcessor,
    { provide: MEDIA_PROCESS_SPAWNER, useValue: spawnMediaProcess },
    { provide: MediaProcessorPort, useExisting: FfmpegMediaProcessor },
    VideoProcessingService,
    VideoProcessor,
    VideoWorkerShutdownService,
  ],
})
export class VideoWorkerModule {}
