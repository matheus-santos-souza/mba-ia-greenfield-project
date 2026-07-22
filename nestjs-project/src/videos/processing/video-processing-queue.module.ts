import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_PROCESSING_COMPLETED_JOB_RETENTION,
  VIDEO_PROCESSING_FAILED_JOB_RETENTION,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing-queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: config.redis,
      }),
    }),
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        name: config.videoProcessingQueue,
        defaultJobOptions: {
          attempts: config.attempts,
          backoff: {
            type: 'exponential',
            delay: config.backoffDelayMs,
          },
          removeOnComplete: {
            count: VIDEO_PROCESSING_COMPLETED_JOB_RETENTION,
          },
          removeOnFail: {
            count: VIDEO_PROCESSING_FAILED_JOB_RETENTION,
          },
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class VideoProcessingQueueModule {}
