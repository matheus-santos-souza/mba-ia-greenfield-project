import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VideoProcessingOutbox } from '../entities/video-processing-outbox.entity';

@Injectable()
export class VideoProcessingOutboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claimAvailable(
    limit: number,
    now: Date,
    leaseDurationMs: number,
  ): Promise<VideoProcessingOutbox[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('Outbox claim limit must be a positive integer');
    }
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new RangeError('Outbox claim lease must be positive');
    }

    const claimedUntil = new Date(now.getTime() + leaseDurationMs);

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(VideoProcessingOutbox);
      const events = await repository
        .createQueryBuilder('outbox')
        .where('outbox.published_at IS NULL')
        .andWhere('outbox.available_at <= :now', { now })
        .orderBy('outbox.available_at', 'ASC')
        .addOrderBy('outbox.created_at', 'ASC')
        .addOrderBy('outbox.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(limit)
        .getMany();

      if (events.length === 0) {
        return [];
      }

      const ids = events.map((event) => event.id);
      await repository
        .createQueryBuilder()
        .update(VideoProcessingOutbox)
        .set({ available_at: claimedUntil })
        .where('id IN (:...ids)', { ids })
        .andWhere('published_at IS NULL')
        .execute();

      for (const event of events) {
        event.available_at = claimedUntil;
      }

      return events;
    });
  }

  async markPublished(eventId: string, publishedAt: Date): Promise<void> {
    await this.dataSource
      .getRepository(VideoProcessingOutbox)
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({ published_at: publishedAt, last_error: null })
      .where('id = :eventId', { eventId })
      .andWhere('published_at IS NULL')
      .execute();
  }

  async rescheduleAfterFailure(
    eventId: string,
    availableAt: Date,
    lastError: string,
  ): Promise<void> {
    await this.dataSource
      .getRepository(VideoProcessingOutbox)
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({
        attempts: () => '"attempts" + 1',
        available_at: availableAt,
        last_error: lastError,
      })
      .where('id = :eventId', { eventId })
      .andWhere('published_at IS NULL')
      .execute();
  }
}
