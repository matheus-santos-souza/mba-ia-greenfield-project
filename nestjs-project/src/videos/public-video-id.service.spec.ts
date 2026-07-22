import { QueryFailedError } from 'typeorm';
import {
  MAX_PUBLIC_ID_ATTEMPTS,
  PublicVideoIdService,
} from './public-video-id.service';

function queryFailure(details: Record<string, unknown>): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('database failure'), details),
  );
}

describe('PublicVideoIdService', () => {
  let service: PublicVideoIdService;

  beforeEach(() => {
    service = new PublicVideoIdService();
  });

  it('generates a 21-character URL-safe Nano ID', () => {
    expect(service.generate()).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it('retries only a public_id unique violation', async () => {
    jest
      .spyOn(service, 'generate')
      .mockReturnValueOnce('a'.repeat(21))
      .mockReturnValueOnce('b'.repeat(21));
    const collision = queryFailure({
      code: '23505',
      constraint: 'UQ_VIDEOS_PUBLIC_ID',
    });
    const persist = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(collision)
      .mockImplementation(async (publicId) => publicId);

    await expect(service.persistWithRetry(persist)).resolves.toBe(
      'b'.repeat(21),
    );
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('recognizes a public_id collision from PostgreSQL detail', async () => {
    const collision = queryFailure({
      code: '23505',
      detail: 'Key (public_id)=(duplicate) already exists.',
    });
    const persist = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce('saved');

    await expect(service.persistWithRetry(persist)).resolves.toBe('saved');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not retry another unique constraint violation', async () => {
    const otherUniqueViolation = queryFailure({
      code: '23505',
      constraint: 'UQ_VIDEO_UPLOADS_UPLOAD_ID',
      detail: 'Key (upload_id)=(duplicate) already exists.',
    });
    const persist = jest.fn().mockRejectedValue(otherUniqueViolation);

    await expect(service.persistWithRetry(persist)).rejects.toBe(
      otherUniqueViolation,
    );
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-unique database failure', async () => {
    const connectionFailure = queryFailure({ code: '08006' });
    const persist = jest.fn().mockRejectedValue(connectionFailure);

    await expect(service.persistWithRetry(persist)).rejects.toBe(
      connectionFailure,
    );
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded number of collision attempts', async () => {
    const collision = queryFailure({
      code: '23505',
      constraint: 'UQ_VIDEOS_PUBLIC_ID',
    });
    const persist = jest.fn().mockRejectedValue(collision);

    await expect(service.persistWithRetry(persist)).rejects.toBe(collision);
    expect(persist).toHaveBeenCalledTimes(MAX_PUBLIC_ID_ATTEMPTS);
  });
});
