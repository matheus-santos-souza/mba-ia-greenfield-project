import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import type { VideoProcessingOutbox } from '../entities/video-processing-outbox.entity';
import type { ProcessVideoJob } from './process-video.job';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_COMPLETED_JOB_RETENTION,
  VIDEO_PROCESSING_FAILED_JOB_RETENTION,
  VIDEO_PROCESSING_JOB_ID_PREFIX,
  VIDEO_PROCESSING_OUTBOX_BATCH_SIZE,
  VIDEO_PROCESSING_OUTBOX_CLAIM_LEASE_MS,
  VIDEO_PROCESSING_OUTBOX_MAX_BACKOFF_MS,
  VIDEO_PROCESSING_OUTBOX_MAX_ERROR_LENGTH,
  VIDEO_PROCESSING_OUTBOX_POLL_INTERVAL_MS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing-queue.constants';
import { VideoProcessingOutboxRepository } from './video-processing-outbox.repository';

type VideoProcessingQueue = Queue<
  ProcessVideoJob,
  void,
  typeof PROCESS_VIDEO_JOB
>;

@Injectable()
export class VideoProcessingOutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(VideoProcessingOutboxRelay.name);
  private loopPromise: Promise<void> | null = null;
  private stopping = false;
  private wakePollWait: (() => void) | null = null;

  constructor(
    private readonly outboxRepository: VideoProcessingOutboxRepository,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: VideoProcessingQueue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.loopPromise !== null) {
      return;
    }

    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wakePollWait?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  async relayOnce(now = new Date()): Promise<number> {
    const events = await this.outboxRepository.claimAvailable(
      VIDEO_PROCESSING_OUTBOX_BATCH_SIZE,
      now,
      VIDEO_PROCESSING_OUTBOX_CLAIM_LEASE_MS,
    );

    for (const event of events) {
      await this.publish(event, now);
    }

    return events.length;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.relayOnce();
      } catch (error) {
        this.logger.error(
          `Outbox relay iteration failed: ${this.sanitizeError(error)}`,
        );
      }

      if (!this.stopping) {
        await this.waitForNextPoll();
      }
    }
  }

  private async publish(
    event: VideoProcessingOutbox,
    attemptedAt: Date,
  ): Promise<void> {
    const payload: ProcessVideoJob = {
      version: 1,
      eventId: event.id,
      videoId: event.video_id,
    };

    try {
      await this.videoProcessingQueue.add(PROCESS_VIDEO_JOB, payload, {
        jobId: `${VIDEO_PROCESSING_JOB_ID_PREFIX}${event.id}`,
        attempts: this.config.attempts,
        backoff: {
          type: 'exponential',
          delay: this.config.backoffDelayMs,
        },
        removeOnComplete: {
          count: VIDEO_PROCESSING_COMPLETED_JOB_RETENTION,
        },
        removeOnFail: {
          count: VIDEO_PROCESSING_FAILED_JOB_RETENTION,
        },
      });
      await this.outboxRepository.markPublished(event.id, attemptedAt);
      this.logger.log(
        `Published processing event eventId=${event.id} videoId=${event.video_id}`,
      );
    } catch (error) {
      const lastError = this.sanitizeError(error);
      const nextAvailableAt = new Date(
        attemptedAt.getTime() + this.backoffDelay(event.attempts),
      );
      await this.outboxRepository.rescheduleAfterFailure(
        event.id,
        nextAvailableAt,
        lastError,
      );
      this.logger.error(
        `Failed processing event eventId=${event.id} videoId=${event.video_id}: ${lastError}`,
      );
      throw error;
    }
  }

  private backoffDelay(previousAttempts: number): number {
    const exponent = Math.min(Math.max(previousAttempts, 0), 20);
    return Math.min(
      this.config.backoffDelayMs * 2 ** exponent,
      VIDEO_PROCESSING_OUTBOX_MAX_BACKOFF_MS,
    );
  }

  private sanitizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const printableMessage = Array.from(message, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    }).join('');

    return printableMessage
      .replaceAll(/ +/g, ' ')
      .trim()
      .slice(0, VIDEO_PROCESSING_OUTBOX_MAX_ERROR_LENGTH);
  }

  private async waitForNextPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(
        resolve,
        VIDEO_PROCESSING_OUTBOX_POLL_INTERVAL_MS,
      );
      this.wakePollWait = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    this.wakePollWait = null;
  }
}
