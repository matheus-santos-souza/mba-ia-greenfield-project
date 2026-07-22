import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Video } from './video.entity';

export const VIDEO_PROCESSING_REQUESTED_EVENT =
  'video.processing.requested' as const;

export interface VideoProcessingRequestedPayload {
  version: 1;
  eventId: string;
  videoId: string;
}

@Entity('video_processing_outbox')
@Unique('UQ_VIDEO_PROCESSING_OUTBOX_VIDEO_EVENT', ['video_id', 'event_type'])
@Index('IDX_VIDEO_PROCESSING_OUTBOX_POLLING', ['available_at', 'created_at'], {
  where: '"published_at" IS NULL',
})
@Check(
  'CHK_VIDEO_PROCESSING_OUTBOX_EVENT_TYPE',
  `"event_type" = '${VIDEO_PROCESSING_REQUESTED_EVENT}'`,
)
export class VideoProcessingOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  video_id: string;

  @Column({ type: 'varchar', length: 100 })
  event_type: typeof VIDEO_PROCESSING_REQUESTED_EVENT;

  @Column({ type: 'jsonb' })
  payload: VideoProcessingRequestedPayload;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  available_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  published_at: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @ManyToOne(() => Video, (video) => video.processing_outbox_events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
