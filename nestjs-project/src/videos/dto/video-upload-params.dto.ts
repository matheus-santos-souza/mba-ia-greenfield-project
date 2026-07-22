import {
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const MAX_UPLOAD_ID_LENGTH = 1024;

export class VideoUploadParamsDto {
  /** Internal video UUID. */
  @IsUUID()
  videoId: string;

  /** Multipart identifier returned by object storage. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_UPLOAD_ID_LENGTH)
  @Matches(/\S/, { message: 'uploadId must not be blank' })
  uploadId: string;
}
