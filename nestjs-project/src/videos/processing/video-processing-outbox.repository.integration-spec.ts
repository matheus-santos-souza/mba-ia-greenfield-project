import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
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
import { VideoProcessingOutboxRepository } from './video-processing-outbox.repository';

describe('VideoProcessingOutboxRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: VideoProcessingOutboxRepository;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let outbox: Repository<VideoProcessingOutbox>;
  let sequence = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      Video,
      VideoProcessingOutbox,
    ]);
    await dataSource.initialize();
    repository = new VideoProcessingOutboxRepository(dataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    outbox = dataSource.getRepository(VideoProcessingOutbox);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createEvent(
    availableAt: Date,
    publishedAt: Date | null = null,
  ): Promise<VideoProcessingOutbox> {
    const suffix = ++sequence;
    const user = await users.save(
      users.create({
        email: `outbox_repository_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Outbox repository ${suffix}`,
        nickname: `outbox-repository-${suffix}`,
        user_id: user.id,
      }),
    );
    const video = await videos.save(
      videos.create({
        channel_id: channel.id,
        public_id: `outbox-repo-${suffix}`,
        title: 'Outbox repository video',
        source_object_key: `videos/outbox-repository-${suffix}/source`,
      }),
    );
    const id = randomUUID();

    return outbox.save(
      outbox.create({
        id,
        video_id: video.id,
        event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
        payload: { version: 1, eventId: id, videoId: video.id },
        available_at: availableAt,
        published_at: publishedAt,
      }),
    );
  }

  it('claims only eligible events in availability order', async () => {
    const logicalNow = new Date('2031-01-01T00:00:00.000Z');
    const first = await createEvent(new Date('2030-01-01T00:00:00.000Z'));
    const second = await createEvent(new Date('2030-06-01T00:00:00.000Z'));
    await createEvent(new Date('2032-01-01T00:00:00.000Z'));
    await createEvent(
      new Date('2030-02-01T00:00:00.000Z'),
      new Date('2030-03-01T00:00:00.000Z'),
    );

    const claimed = await repository.claimAvailable(2, logicalNow, 30_000);

    expect(claimed.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(claimed.every((event) => event.published_at === null)).toBe(true);
  });

  it('uses skip-locked claims so concurrent relays do not share rows', async () => {
    const logicalNow = new Date('2031-01-01T00:00:00.000Z');
    await createEvent(new Date('2030-01-01T00:00:00.000Z'));
    await createEvent(new Date('2030-01-02T00:00:00.000Z'));

    const [left, right] = await Promise.all([
      repository.claimAvailable(1, logicalNow, 30_000),
      repository.claimAvailable(1, logicalNow, 30_000),
    ]);

    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0].id).not.toBe(right[0].id);
  });

  it('redelivers a claimed event only after its lease expires', async () => {
    const logicalNow = new Date('2031-01-01T00:00:00.000Z');
    const event = await createEvent(new Date('2030-01-01T00:00:00.000Z'));

    const firstClaim = await repository.claimAvailable(1, logicalNow, 1_000);
    const duringLease = await repository.claimAvailable(
      1,
      new Date(logicalNow.getTime() + 999),
      1_000,
    );
    const afterLease = await repository.claimAvailable(
      1,
      new Date(logicalNow.getTime() + 1_001),
      1_000,
    );

    expect(firstClaim[0].id).toBe(event.id);
    expect(duringLease).toEqual([]);
    expect(afterLease[0].id).toBe(event.id);
  });
});
