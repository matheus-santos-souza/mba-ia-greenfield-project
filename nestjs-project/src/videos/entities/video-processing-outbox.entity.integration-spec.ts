import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import {
  VIDEO_PROCESSING_REQUESTED_EVENT,
  VideoProcessingOutbox,
} from './video-processing-outbox.entity';
import { VideoUpload } from './video-upload.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
  VideoProcessingOutbox,
];

describe('VideoProcessingOutbox entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let outboxRepository: Repository<VideoProcessingOutbox>;
  let sequence = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    outboxRepository = dataSource.getRepository(VideoProcessingOutbox);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createVideo(): Promise<Video> {
    const suffix = ++sequence;
    const user = await userRepository.save(
      userRepository.create({
        email: `outbox_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Outbox Owner ${suffix}`,
        nickname: `outbox-owner-${suffix}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        public_id: `outbox-public-${suffix}`,
        title: 'Outbox integration video',
        source_object_key: `videos/${channel.id}/source`,
      }),
    );
  }

  function newEvent(video: Video): VideoProcessingOutbox {
    const event = outboxRepository.create({
      video_id: video.id,
      event_type: VIDEO_PROCESSING_REQUESTED_EVENT,
    });
    event.payload = {
      version: 1,
      eventId: event.id ?? 'pending-event-id',
      videoId: video.id,
    };
    return event;
  }

  it('should persist JSONB payload and publication defaults', async () => {
    const video = await createVideo();
    const event = newEvent(video);
    event.id = '10000000-0000-4000-8000-000000000001';
    event.payload.eventId = event.id;

    const saved = await outboxRepository.save(event);
    const found = await outboxRepository.findOneByOrFail({ id: saved.id });

    expect(found.payload).toEqual({
      version: 1,
      eventId: event.id,
      videoId: video.id,
    });
    expect(found.attempts).toBe(0);
    expect(found.available_at).toBeInstanceOf(Date);
    expect(found.published_at).toBeNull();
    expect(found.last_error).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should allow only one processing-requested event per video', async () => {
    const video = await createVideo();
    await outboxRepository.save(newEvent(video));

    await expect(outboxRepository.save(newEvent(video))).rejects.toThrow();
  });

  it('should reject unsupported event types and orphan videos', async () => {
    const video = await createVideo();
    const invalidType = newEvent(video);
    invalidType.event_type = 'video.processing.other' as never;
    await expect(outboxRepository.save(invalidType)).rejects.toThrow();

    const orphan = newEvent(video);
    orphan.video_id = '00000000-0000-4000-8000-000000000000';
    await expect(outboxRepository.save(orphan)).rejects.toThrow();
  });

  it('should cascade outbox deletion when its video is deleted', async () => {
    const video = await createVideo();
    await outboxRepository.save(newEvent(video));

    await videoRepository.delete(video.id);

    expect(await outboxRepository.count()).toBe(0);
  });
});
