import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import {
  VIDEO_PROCESSING_REQUESTED_EVENT,
  VideoProcessingOutbox,
} from '../entities/video-processing-outbox.entity';
import { Video } from '../entities/video.entity';
import { VideosModule } from '../videos.module';
import type { ProcessVideoJob } from './process-video.job';
import { VideoProcessingOutboxRelay } from './video-processing-outbox-relay';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing-queue.constants';

type VideoQueue = Queue<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>;

describe('Video processing queue publication (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let queue: VideoQueue;
  let relay: VideoProcessingOutboxRelay;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let outbox: Repository<VideoProcessingOutbox>;
  let sequence = 0;
  const physicalQueueName = `video-processing-test-${process.pid}`;
  const logicalNow = new Date('2031-01-01T00:00:00.000Z');

  beforeAll(async () => {
    const testDataSource = createTestDataSource([
      User,
      Channel,
      Video,
      VideoProcessingOutbox,
    ]);
    const testQueueConfig = {
      redis: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      videoProcessingQueue: physicalQueueName,
      attempts: 3,
      backoffDelayMs: 1_000,
    };

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(testDataSource.options),
        VideosModule,
      ],
    })
      .overrideProvider(queueConfig.KEY)
      .useValue(testQueueConfig)
      .compile();

    dataSource = module.get(DataSource);
    queue = module.get<VideoQueue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    relay = module.get(VideoProcessingOutboxRelay);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    outbox = dataSource.getRepository(VideoProcessingOutbox);
    await queue.waitUntilReady();
  }, 30_000);

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await module?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function createEvent(): Promise<VideoProcessingOutbox> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `queue_publication_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Queue publication ${suffix}`,
        nickname: `queue-publication-${suffix}`,
        user_id: user.id,
      }),
    );
    const video = await videos.save(
      videos.create({
        channel_id: channel.id,
        public_id: `queue-publish-${suffix}`,
        title: 'Queue publication video',
        source_object_key: `videos/queue-publication-${suffix}/source`,
      }),
    );
    const id = randomUUID();

    return outbox.save(
      outbox.create({
        id,
        video_id: video.id,
        event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
        payload: { version: 1, eventId: id, videoId: video.id },
        available_at: new Date('2030-01-01T00:00:00.000Z'),
      }),
    );
  }

  it('publishes the persisted event to Redis before marking it published', async () => {
    const event = await createEvent();

    await expect(relay.relayOnce(logicalNow)).resolves.toBe(1);

    const job = await queue.getJob(`video-processing-${event.id}`);
    const persisted = await outbox.findOneByOrFail({ id: event.id });
    expect(job).not.toBeUndefined();
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({
      version: 1,
      eventId: event.id,
      videoId: event.video_id,
    });
    expect(persisted.published_at?.getTime()).toBe(logicalNow.getTime());
  });

  it('deduplicates a republished event by deterministic job id', async () => {
    const event = await createEvent();
    await relay.relayOnce(logicalNow);
    await outbox.update(event.id, {
      published_at: null,
      available_at: new Date('2030-01-01T00:00:00.000Z'),
    });

    await expect(
      relay.relayOnce(new Date(logicalNow.getTime() + 60_000)),
    ).resolves.toBe(1);

    const jobs = await queue.getJobs([
      'active',
      'completed',
      'delayed',
      'failed',
      'prioritized',
      'waiting',
      'waiting-children',
    ]);
    const persisted = await outbox.findOneByOrFail({ id: event.id });
    expect(jobs.map((job) => job.id)).toEqual([`video-processing-${event.id}`]);
    expect(persisted.published_at).not.toBeNull();
  });
});
