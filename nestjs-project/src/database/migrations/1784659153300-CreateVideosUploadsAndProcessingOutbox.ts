import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosUploadsAndProcessingOutbox1784659153300 implements MigrationInterface {
  name = 'CreateVideosUploadsAndProcessingOutbox1784659153300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "video_processing_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "event_type" character varying(100) NOT NULL, "payload" jsonb NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_VIDEO_PROCESSING_OUTBOX_VIDEO_EVENT" UNIQUE ("video_id", "event_type"), CONSTRAINT "CHK_VIDEO_PROCESSING_OUTBOX_EVENT_TYPE" CHECK ("event_type" = 'video.processing.requested'), CONSTRAINT "PK_39dcfd3c9dbeb68310241a09b72" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_VIDEO_PROCESSING_OUTBOX_POLLING" ON "video_processing_outbox" ("available_at", "created_at") WHERE "published_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."video_uploads_status_enum" AS ENUM('initiated', 'completed', 'aborted')`,
    );
    await queryRunner.query(
      `CREATE TABLE "video_uploads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "upload_id" text NOT NULL, "object_key" text NOT NULL, "file_size" bigint NOT NULL, "content_type" character varying(100) NOT NULL, "part_size" integer NOT NULL, "status" "public"."video_uploads_status_enum" NOT NULL DEFAULT 'initiated', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "REL_06a943c51e95702c3e84693180" UNIQUE ("video_id"), CONSTRAINT "CHK_VIDEO_UPLOADS_PART_SIZE" CHECK ("part_size" >= 5242880), CONSTRAINT "CHK_VIDEO_UPLOADS_FILE_SIZE" CHECK ("file_size" BETWEEN 1 AND 10737418240), CONSTRAINT "PK_c3def71eaaba3a49539786ef82a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_VIDEO_UPLOADS_STATUS_EXPIRES_AT" ON "video_uploads" ("status", "expires_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_VIDEO_UPLOADS_UPLOAD_ID" ON "video_uploads" ("upload_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "public_id" character varying(21) NOT NULL, "title" character varying(255) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "source_object_key" text NOT NULL, "playback_object_key" text, "thumbnail_object_key" text, "duration_seconds" numeric(12,3), "metadata" jsonb, "processing_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "CHK_VIDEOS_DURATION_NON_NEGATIVE" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_VIDEOS_CHANNEL_STATUS" ON "videos" ("channel_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_VIDEOS_CHANNEL_ID" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_VIDEOS_PUBLIC_ID" ON "videos" ("public_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD CONSTRAINT "FK_b5164922ea5553e56eeb637863a" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_uploads" ADD CONSTRAINT "FK_06a943c51e95702c3e84693180f" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_uploads" DROP CONSTRAINT "FK_06a943c51e95702c3e84693180f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP CONSTRAINT "FK_b5164922ea5553e56eeb637863a"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_VIDEOS_PUBLIC_ID"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_VIDEOS_CHANNEL_ID"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_VIDEOS_CHANNEL_STATUS"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_VIDEO_UPLOADS_UPLOAD_ID"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_VIDEO_UPLOADS_STATUS_EXPIRES_AT"`,
    );
    await queryRunner.query(`DROP TABLE "video_uploads"`);
    await queryRunner.query(`DROP TYPE "public"."video_uploads_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_VIDEO_PROCESSING_OUTBOX_POLLING"`,
    );
    await queryRunner.query(`DROP TABLE "video_processing_outbox"`);
  }
}
