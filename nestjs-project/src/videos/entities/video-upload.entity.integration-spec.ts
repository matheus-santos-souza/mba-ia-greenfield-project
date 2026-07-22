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
import { VideoUpload, VideoUploadStatus } from './video-upload.entity';
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

describe('VideoUpload entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let uploadRepository: Repository<VideoUpload>;
  let sequence = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    uploadRepository = dataSource.getRepository(VideoUpload);
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
        email: `upload_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Upload Owner ${suffix}`,
        nickname: `upload-owner-${suffix}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        public_id: `upload-public-${suffix}`,
        title: 'Upload integration video',
        source_object_key: `videos/${channel.id}/source`,
      }),
    );
  }

  function newUpload(video: Video, uploadId: string): VideoUpload {
    return uploadRepository.create({
      video_id: video.id,
      upload_id: uploadId,
      object_key: video.source_object_key,
      file_size: '10485760',
      content_type: 'video/mp4',
      part_size: 5242880,
      expires_at: new Date(Date.now() + 60_000),
    });
  }

  it('should persist expiration, relation and initiated defaults', async () => {
    const video = await createVideo();
    const expiresAt = new Date(Date.now() + 60_000);
    const upload = newUpload(video, 'upload-defaults');
    upload.expires_at = expiresAt;

    const saved = await uploadRepository.save(upload);
    const found = await uploadRepository.findOne({
      where: { id: saved.id },
      relations: ['video'],
    });

    expect(found).toMatchObject({
      status: VideoUploadStatus.INITIATED,
      completed_at: null,
      video_id: video.id,
    });
    expect(found?.expires_at).toEqual(expiresAt);
    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.updated_at).toBeInstanceOf(Date);
    expect(found?.video.id).toBe(video.id);
  });

  it('should allow only one upload session per video', async () => {
    const video = await createVideo();
    await uploadRepository.save(newUpload(video, 'upload-one'));

    await expect(
      uploadRepository.save(newUpload(video, 'upload-two')),
    ).rejects.toThrow();
  });

  it('should reject duplicate storage upload identifiers', async () => {
    const firstVideo = await createVideo();
    const secondVideo = await createVideo();
    await uploadRepository.save(newUpload(firstVideo, 'shared-upload-id'));

    await expect(
      uploadRepository.save(newUpload(secondVideo, 'shared-upload-id')),
    ).rejects.toThrow();
  });

  it('should enforce file-size and multipart part-size bounds', async () => {
    const video = await createVideo();
    const emptyUpload = newUpload(video, 'empty-upload');
    emptyUpload.file_size = '0';
    await expect(uploadRepository.save(emptyUpload)).rejects.toThrow();

    const oversizedUpload = newUpload(video, 'oversized-upload');
    oversizedUpload.file_size = '10737418241';
    await expect(uploadRepository.save(oversizedUpload)).rejects.toThrow();

    const undersizedPart = newUpload(video, 'undersized-part');
    undersizedPart.part_size = 5242879;
    await expect(uploadRepository.save(undersizedPart)).rejects.toThrow();
  });

  it('should reject invalid status values and orphan videos', async () => {
    const video = await createVideo();
    const invalidStatus = newUpload(video, 'invalid-status');
    invalidStatus.status = 'invalid' as VideoUploadStatus;
    await expect(uploadRepository.save(invalidStatus)).rejects.toThrow();

    const orphan = newUpload(video, 'orphan-upload');
    orphan.video_id = '00000000-0000-4000-8000-000000000000';
    await expect(uploadRepository.save(orphan)).rejects.toThrow();
  });
});
