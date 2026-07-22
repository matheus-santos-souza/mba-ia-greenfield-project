import { ApiProperty } from '@nestjs/swagger';
import { VideoUploadStatus } from '../entities/video-upload.entity';
import { VideoStatus } from '../entities/video.entity';

export class InitiateVideoUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  video_id: string;

  @ApiProperty({ minLength: 21, maxLength: 21 })
  public_id: string;

  @ApiProperty()
  upload_id: string;

  @ApiProperty({ type: 'integer' })
  part_size: number;

  @ApiProperty({ enum: [VideoStatus.DRAFT] })
  status: VideoStatus.DRAFT;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}

export class UploadedVideoPartResponseDto {
  @ApiProperty({ type: 'integer' })
  part_number: number;

  @ApiProperty()
  etag: string;

  @ApiProperty({ type: 'integer' })
  size: number;
}

export class ResumeVideoUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  video_id: string;

  @ApiProperty()
  upload_id: string;

  @ApiProperty({ type: 'integer' })
  part_size: number;

  @ApiProperty({ type: 'integer' })
  file_size: number;

  @ApiProperty({ enum: VideoUploadStatus })
  status: VideoUploadStatus;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;

  @ApiProperty({ type: [UploadedVideoPartResponseDto] })
  uploaded_parts: UploadedVideoPartResponseDto[];
}

export class SignedVideoPartResponseDto {
  @ApiProperty({ type: 'integer' })
  part_number: number;

  @ApiProperty({ format: 'uri' })
  upload_url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}

export class SignVideoUploadPartsResponseDto {
  @ApiProperty({ type: [SignedVideoPartResponseDto] })
  parts: SignedVideoPartResponseDto[];
}

export class CompleteVideoUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  video_id: string;

  @ApiProperty({ minLength: 21, maxLength: 21 })
  public_id: string;

  @ApiProperty({ enum: [VideoStatus.PROCESSING] })
  status: VideoStatus.PROCESSING;
}
