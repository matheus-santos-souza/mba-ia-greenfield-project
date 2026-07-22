import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import type { ObjectStoragePort } from '../../storage/object-storage.port';
import {
  OBJECT_STORAGE_PORT,
  S3_INTERNAL_CLIENT,
} from '../../storage/storage.constants';
import { StorageModule } from '../../storage/storage.module';
import { VideoStorageKeyService } from '../../storage/video-storage-key.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import type { ProcessVideoJob } from './process-video.job';
import {
  FfmpegMediaProcessor,
  MEDIA_PROCESS_SPAWNER,
  spawnMediaProcess,
} from './ffmpeg-media-processor';
import { MediaProcessorPort } from './media-processor.port';
import { PROCESS_VIDEO_JOB } from './video-processing-queue.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';
import { VideoRepository } from '../video.repository';

type VideoQueue = Queue<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>;

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve();
    });
  });
}

async function eventually<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  if (!matches(value)) {
    throw new Error('Timed out waiting for video processing state');
  }
  return value;
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let queue: VideoQueue;
  let worker: Worker<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>;
  let storage: ObjectStoragePort;
  let storageKeys: VideoStorageKeyService;
  let s3Client: S3Client;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let directory: string;
  let fixturePath: string;
  let bucket: string;
  let sequence = 0;
  const objectKeys = new Set<string>();
  const physicalQueueName = `video-processor-integration-${process.pid}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'video-worker-integration-'));
    fixturePath = join(directory, 'source.mov');
    await run(process.env.FFMPEG_PATH ?? '/usr/bin/ffmpeg', [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=160x120:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '1',
      '-shortest',
      '-c:v',
      'mpeg4',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      fixturePath,
    ]);

    dataSource = createTestDataSource([]);
    await dataSource.initialize();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        StorageModule,
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        VideoRepository,
        FfmpegMediaProcessor,
        { provide: MEDIA_PROCESS_SPAWNER, useValue: spawnMediaProcess },
        { provide: MediaProcessorPort, useExisting: FfmpegMediaProcessor },
        VideoProcessingService,
        VideoProcessor,
      ],
    }).compile();
    storage = module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT);
    storageKeys = module.get(VideoStorageKeyService);
    s3Client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';
    const connection = {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    };
    queue = new Queue<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>(
      physicalQueueName,
      {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 100 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      },
    );
    const processor = module.get(VideoProcessor);
    worker = new Worker<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>(
      physicalQueueName,
      (job) => processor.process(job),
      { connection, concurrency: 1 },
    );
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  }, 30_000);

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    objectKeys.clear();
  });

  afterEach(async () => {
    await Promise.all(
      [...objectKeys].map((objectKey) =>
        s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
        ),
      ),
    );
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await module.close();
    await dataSource.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function createVideo(sourceExists: boolean): Promise<Video> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `video_worker_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Video Worker ${suffix}`,
        nickname: `video-worker-${suffix}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    const sourceObjectKey = `videos/${videoId}/source/original`;
    const video = await videos.save(
      videos.create({
        id: videoId,
        channel_id: channel.id,
        public_id: `worker-${suffix}`,
        title: 'Worker integration fixture',
        status: VideoStatus.PROCESSING,
        source_object_key: sourceObjectKey,
      }),
    );

    if (sourceExists) {
      const { size } = await stat(fixturePath);
      await storage.uploadObject({
        objectKey: sourceObjectKey,
        body: createReadStream(fixturePath),
        contentLength: size,
        contentType: 'video/quicktime',
      });
      objectKeys.add(sourceObjectKey);
    }
    return video;
  }

  it('consumes a real job and persists ready state after uploading both artifacts', async () => {
    const video = await createVideo(true);
    const playbackObjectKey = storageKeys.playback(video.id);
    const thumbnailObjectKey = storageKeys.thumbnail(video.id);
    objectKeys.add(playbackObjectKey);
    objectKeys.add(thumbnailObjectKey);

    await queue.add(
      PROCESS_VIDEO_JOB,
      { version: 1, eventId: randomUUID(), videoId: video.id },
      { jobId: `worker-success-${video.id}` },
    );

    const persisted = await eventually(
      () => videos.findOneByOrFail({ id: video.id }),
      (candidate) => candidate.status === VideoStatus.READY,
    );
    const [playback, thumbnail] = await Promise.all([
      storage.headObject(playbackObjectKey),
      storage.headObject(thumbnailObjectKey),
    ]);

    expect(persisted.duration_seconds).not.toBeNull();
    expect(persisted.metadata).toEqual(
      expect.objectContaining({
        format: expect.any(String),
        codec: 'mpeg4',
        width: 160,
        height: 120,
      }),
    );
    expect(persisted.playback_object_key).toBe(playbackObjectKey);
    expect(persisted.thumbnail_object_key).toBe(thumbnailObjectKey);
    expect(persisted.processing_error).toBeNull();
    expect(playback.contentLength).toBeGreaterThan(0);
    expect(thumbnail.contentLength).toBeGreaterThan(0);
  }, 30_000);

  it('retries a failure and marks the video error only on the terminal attempt', async () => {
    const video = await createVideo(false);
    const job = await queue.add(
      PROCESS_VIDEO_JOB,
      { version: 1, eventId: randomUUID(), videoId: video.id },
      { jobId: `worker-failure-${video.id}` },
    );

    const persisted = await eventually(
      () => videos.findOneByOrFail({ id: video.id }),
      (candidate) => candidate.status === VideoStatus.ERROR,
    );
    const state = await eventually(
      () => job.getState(),
      (candidate) => candidate === 'failed',
    );
    const refreshedJob = await queue.getJob(job.id ?? '');

    expect(state).toBe('failed');
    expect(refreshedJob?.attemptsMade).toBe(3);
    expect(persisted.processing_error).toBeTruthy();
    expect(persisted.processing_error).not.toContain('http://');
  }, 30_000);
});
