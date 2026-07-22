import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoProcessingOutbox } from './video-processing-outbox.entity';
import { VideoUpload } from './video-upload.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

export interface VideoMetadata {
  format: string;
  codec: string;
  width: number;
  height: number;
  bit_rate: number;
  size_bytes: number;
}

@Entity('videos')
@Index('UQ_VIDEOS_PUBLIC_ID', ['public_id'], { unique: true })
@Index('IDX_VIDEOS_CHANNEL_ID', ['channel_id'])
@Index('IDX_VIDEOS_CHANNEL_STATUS', ['channel_id', 'status'])
@Check(
  'CHK_VIDEOS_DURATION_NON_NEGATIVE',
  '"duration_seconds" IS NULL OR "duration_seconds" >= 0',
)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 21 })
  public_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'videos_status_enum',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'text' })
  source_object_key: string;

  @Column({ type: 'text', nullable: true })
  playback_object_key: string | null;

  @Column({ type: 'text', nullable: true })
  thumbnail_object_key: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @OneToOne(() => VideoUpload, (upload) => upload.video)
  upload: VideoUpload | null;

  @OneToMany(() => VideoProcessingOutbox, (event) => event.video)
  processing_outbox_events: VideoProcessingOutbox[];
}
