import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { createTestDataSource } from '../test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from './processing/video-processing-queue.constants';
import { VideoUploadService } from './video-upload.service';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('compiles DI with TypeORM, storage, channels and BullMQ configured', async () => {
    const physicalQueueName = `videos-module-test-${process.pid}`;
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource([]).options),
        VideosModule,
      ],
    })
      .overrideProvider(queueConfig.KEY)
      .useValue({
        redis: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: Number(process.env.REDIS_PORT ?? 6379),
        },
        videoProcessingQueue: physicalQueueName,
        attempts: 3,
        backoffDelayMs: 1_000,
      })
      .compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await queue.waitUntilReady();
    expect(module.get(VideoUploadService)).toBeInstanceOf(VideoUploadService);
    expect(module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT)).toBeDefined();
    expect(queue.name).toBe(physicalQueueName);

    await module.close();
  }, 30_000);
});
