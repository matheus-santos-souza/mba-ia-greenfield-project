import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoProcessingOutbox } from './video-processing-outbox.entity';
import { VideoUpload } from './video-upload.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
  VideoProcessingOutbox,
];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let sequence = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const suffix = ++sequence;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );

    return channelRepository.save(
      channelRepository.create({
        name: `Video Owner ${suffix}`,
        nickname: `video-owner-${suffix}`,
        user_id: user.id,
      }),
    );
  }

  function newVideo(channel: Channel, publicId: string): Video {
    return videoRepository.create({
      channel_id: channel.id,
      public_id: publicId,
      title: 'Integration video',
      source_object_key: `videos/${channel.id}/source`,
    });
  }

  it('should persist generated identifiers, defaults, timestamps and channel relation', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      newVideo(channel, 'public-video-default1'),
    );
    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(found).toMatchObject({
      status: VideoStatus.DRAFT,
      playback_object_key: null,
      thumbnail_object_key: null,
      duration_seconds: null,
      metadata: null,
      processing_error: null,
    });
    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.updated_at).toBeInstanceOf(Date);
    expect(found?.channel.id).toBe(channel.id);
  });

  it('should reject duplicate public identifiers', async () => {
    const channel = await createChannel();
    const publicId = 'duplicate-public-id01';
    await videoRepository.save(newVideo(channel, publicId));

    await expect(
      videoRepository.save(newVideo(channel, publicId)),
    ).rejects.toThrow();
  });

  it('should reject invalid status values', async () => {
    const channel = await createChannel();
    const video = newVideo(channel, 'invalid-status-video1');
    video.status = 'invalid' as VideoStatus;

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should reject orphan channel references and negative durations', async () => {
    const channel = await createChannel();
    const orphan = newVideo(channel, 'orphan-video-public1');
    orphan.channel_id = '00000000-0000-4000-8000-000000000000';

    await expect(videoRepository.save(orphan)).rejects.toThrow();

    const negativeDuration = newVideo(channel, 'negative-duration-01');
    negativeDuration.duration_seconds = '-0.001';
    await expect(videoRepository.save(negativeDuration)).rejects.toThrow();
  });

  it('should expose the named lookup indexes in PostgreSQL', async () => {
    const rows = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'videos'`,
    );

    expect(rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'UQ_VIDEOS_PUBLIC_ID',
        'IDX_VIDEOS_CHANNEL_ID',
        'IDX_VIDEOS_CHANNEL_STATUS',
      ]),
    );
  });
});
