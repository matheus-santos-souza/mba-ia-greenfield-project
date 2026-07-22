import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Video } from './video.entity';

export enum VideoUploadStatus {
  INITIATED = 'initiated',
  COMPLETED = 'completed',
  ABORTED = 'aborted',
}

@Entity('video_uploads')
@Index('UQ_VIDEO_UPLOADS_UPLOAD_ID', ['upload_id'], { unique: true })
@Index('IDX_VIDEO_UPLOADS_STATUS_EXPIRES_AT', ['status', 'expires_at'])
@Check('CHK_VIDEO_UPLOADS_FILE_SIZE', '"file_size" BETWEEN 1 AND 10737418240')
@Check('CHK_VIDEO_UPLOADS_PART_SIZE', '"part_size" >= 5242880')
export class VideoUpload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  video_id: string;

  @Column({ type: 'text' })
  upload_id: string;

  @Column({ type: 'text' })
  object_key: string;

  @Column({ type: 'bigint' })
  file_size: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'integer' })
  part_size: number;

  @Column({
    type: 'enum',
    enum: VideoUploadStatus,
    enumName: 'video_uploads_status_enum',
    default: VideoUploadStatus.INITIATED,
  })
  status: VideoUploadStatus;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @OneToOne(() => Video, (video) => video.upload, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
