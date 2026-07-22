import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing-queue.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';

describe('VideoProcessingQueueModule', () => {
  it('compiles DI with a configured BullMQ queue and closes it', async () => {
    const physicalQueueName = `video-processing-module-test-${process.pid}`;
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingQueueModule,
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
    expect(queue.name).toBe(physicalQueueName);

    await module.close();
    await expect(queue.closing).resolves.toBeUndefined();
  });
});
