import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_CONSTRAINT = 'UQ_VIDEOS_PUBLIC_ID';
const PUBLIC_ID_COLUMN = 'public_id';
export const MAX_PUBLIC_ID_ATTEMPTS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const candidates: unknown[] = [error, error.driverError];
  return candidates.some((candidate) => {
    if (!isRecord(candidate) || candidate.code !== PG_UNIQUE_VIOLATION) {
      return false;
    }

    return (
      candidate.constraint === PUBLIC_ID_CONSTRAINT ||
      (typeof candidate.detail === 'string' &&
        candidate.detail.includes(PUBLIC_ID_COLUMN))
    );
  });
}

@Injectable()
export class PublicVideoIdService {
  generate(): string {
    return nanoid();
  }

  async persistWithRetry<T>(
    persist: (publicId: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
      try {
        return await persist(this.generate());
      } catch (error) {
        if (!isPublicIdCollision(error) || attempt === MAX_PUBLIC_ID_ATTEMPTS) {
          throw error;
        }
      }
    }

    throw new Error('Public video identifier retry invariant was violated');
  }
}
