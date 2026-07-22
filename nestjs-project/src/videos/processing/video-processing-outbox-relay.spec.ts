import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import queueConfig from '../../config/queue.config';
import type { VideoProcessingOutbox } from '../entities/video-processing-outbox.entity';
import { VideoProcessingOutboxRelay } from './video-processing-outbox-relay';
import { VideoProcessingOutboxRepository } from './video-processing-outbox.repository';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_OUTBOX_MAX_BACKOFF_MS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing-queue.constants';

type OutboxRepositoryMock = jest.Mocked<
  Pick<
    VideoProcessingOutboxRepository,
    'claimAvailable' | 'markPublished' | 'rescheduleAfterFailure'
  >
>;

describe('VideoProcessingOutboxRelay', () => {
  const config = {
    redis: { host: 'redis', port: 6379 },
    videoProcessingQueue: VIDEO_PROCESSING_QUEUE,
    attempts: 3,
    backoffDelayMs: 1_000,
  };
  let repository: OutboxRepositoryMock;
  let queue: { add: jest.Mock };
  let relay: VideoProcessingOutboxRelay;

  function event(attempts = 0): VideoProcessingOutbox {
    return {
      id: '10000000-0000-4000-8000-000000000001',
      video_id: '20000000-0000-4000-8000-000000000002',
      event_type: PROCESS_VIDEO_JOB,
      payload: {
        version: 1,
        eventId: '10000000-0000-4000-8000-000000000001',
        videoId: '20000000-0000-4000-8000-000000000002',
      },
      attempts,
      available_at: new Date('2030-01-01T00:00:00.000Z'),
      published_at: null,
      last_error: null,
      created_at: new Date('2030-01-01T00:00:00.000Z'),
      video: {} as VideoProcessingOutbox['video'],
    };
  }

  beforeEach(async () => {
    repository = {
      claimAvailable: jest.fn(),
      markPublished: jest.fn(),
      rescheduleAfterFailure: jest.fn(),
    };
    queue = { add: jest.fn() };
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingOutboxRelay,
        { provide: VideoProcessingOutboxRepository, useValue: repository },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: queueConfig.KEY, useValue: config },
      ],
    }).compile();

    relay = module.get(VideoProcessingOutboxRelay);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes a typed deterministic job before marking the event', async () => {
    const outboxEvent = event();
    const attemptedAt = new Date('2031-01-01T00:00:00.000Z');
    repository.claimAvailable.mockResolvedValue([outboxEvent]);
    queue.add.mockResolvedValue({ id: 'job' });

    await expect(relay.relayOnce(attemptedAt)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      {
        version: 1,
        eventId: outboxEvent.id,
        videoId: outboxEvent.video_id,
      },
      expect.objectContaining({
        jobId: `video-processing-${outboxEvent.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      }),
    );
    expect(repository.markPublished).toHaveBeenCalledWith(
      outboxEvent.id,
      attemptedAt,
    );
    expect(queue.add.mock.invocationCallOrder[0]).toBeLessThan(
      repository.markPublished.mock.invocationCallOrder[0],
    );
  });

  it('reschedules a failed publication with exponential backoff and rethrows', async () => {
    const outboxEvent = event(2);
    const attemptedAt = new Date('2031-01-01T00:00:00.000Z');
    const failure = new Error('Redis\nconnection unavailable');
    repository.claimAvailable.mockResolvedValue([outboxEvent]);
    queue.add.mockRejectedValue(failure);

    await expect(relay.relayOnce(attemptedAt)).rejects.toBe(failure);

    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.rescheduleAfterFailure).toHaveBeenCalledWith(
      outboxEvent.id,
      new Date(attemptedAt.getTime() + 4_000),
      'Redis connection unavailable',
    );
  });

  it('bounds retry delay and persisted error size', async () => {
    const outboxEvent = event(50);
    const attemptedAt = new Date('2031-01-01T00:00:00.000Z');
    repository.claimAvailable.mockResolvedValue([outboxEvent]);
    queue.add.mockRejectedValue(new Error('x'.repeat(2_000)));

    await expect(relay.relayOnce(attemptedAt)).rejects.toThrow();

    const [, availableAt, lastError] =
      repository.rescheduleAfterFailure.mock.calls[0];
    expect(availableAt.getTime() - attemptedAt.getTime()).toBe(
      VIDEO_PROCESSING_OUTBOX_MAX_BACKOFF_MS,
    );
    expect(lastError).toHaveLength(1_000);
  });

  it('runs one loop at a time and cancels its wait during shutdown', async () => {
    let finishClaim: (events: VideoProcessingOutbox[]) => void = () =>
      undefined;
    repository.claimAvailable.mockImplementation(
      () =>
        new Promise<VideoProcessingOutbox[]>((resolve) => {
          finishClaim = resolve;
        }),
    );

    relay.onApplicationBootstrap();
    relay.onApplicationBootstrap();
    await Promise.resolve();

    expect(repository.claimAvailable).toHaveBeenCalledTimes(1);

    const shutdown = relay.beforeApplicationShutdown();
    finishClaim([]);
    await shutdown;

    expect(repository.claimAvailable).toHaveBeenCalledTimes(1);
  });
});
