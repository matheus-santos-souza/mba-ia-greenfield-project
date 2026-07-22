import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InitiateVideoUploadDto {
  /** Video title, containing between 1 and 255 characters after trimming. */
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /** Declared source file size in bytes. */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  file_size: number;

  /** Declared source media type. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  content_type: string;
}
