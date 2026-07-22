import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from '../videos/entities/video.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';
import { VideoProcessingOutbox } from '../videos/entities/video-processing-outbox.entity';
import { CreateVideosUploadsAndProcessingOutbox1784659153300 } from './migrations/1784659153300-CreateVideosUploadsAndProcessingOutbox';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'video_uploads',
  'video_processing_outbox',
];

const VIDEO_TABLES = ['videos', 'video_uploads', 'video_processing_outbox'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [
        User,
        Channel,
        RefreshToken,
        VerificationToken,
        Video,
        VideoUpload,
        VideoProcessingOutbox,
      ],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideosUploadsAndProcessingOutbox1784659153300,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."video_uploads_status_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."videos_status_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create the complete video schema', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'video_processing_outbox',
      'video_uploads',
      'videos',
    ]);

    const indexes = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])`,
      [VIDEO_TABLES],
    );
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'UQ_VIDEOS_PUBLIC_ID',
        'IDX_VIDEOS_CHANNEL_ID',
        'IDX_VIDEOS_CHANNEL_STATUS',
        'UQ_VIDEO_UPLOADS_UPLOAD_ID',
        'IDX_VIDEO_UPLOADS_STATUS_EXPIRES_AT',
        'IDX_VIDEO_PROCESSING_OUTBOX_POLLING',
      ]),
    );
  });

  it('should revert the video migration without removing prior-phase tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [MANAGED_TABLES],
    );
    expect(result.map((row) => row.table_name).sort()).toEqual(
      ['channels', 'refresh_tokens', 'users', 'verification_tokens'].sort(),
    );

    const enumRows = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typname = ANY($1::text[])`,
      [['videos_status_enum', 'video_uploads_status_enum']],
    );
    expect(enumRows).toHaveLength(0);
  });
});
