import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

const MAX_MULTIPART_PARTS = 10_000;

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CompleteVideoUploadPartDto {
  /** Multipart part number. */
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  part_number: number;

  /** ETag returned by object storage after uploading the part. */
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  etag: string;
}

@ValidatorConstraint({ name: 'strictlyAscendingPartNumbers', async: false })
class StrictlyAscendingPartNumbersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return false;
    }

    return value.every((part: unknown, index: number) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('part_number' in part) ||
        typeof part.part_number !== 'number'
      ) {
        return false;
      }

      if (index === 0) {
        return true;
      }

      const previous: unknown = value[index - 1];
      return (
        typeof previous === 'object' &&
        previous !== null &&
        'part_number' in previous &&
        typeof previous.part_number === 'number' &&
        part.part_number > previous.part_number
      );
    });
  }

  defaultMessage(): string {
    return 'parts must be ordered by strictly ascending part_number';
  }
}

export class CompleteVideoUploadDto {
  /** Complete, distinct and ascending multipart manifest. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MULTIPART_PARTS)
  @ArrayUnique((part: CompleteVideoUploadPartDto) => part.part_number)
  @Validate(StrictlyAscendingPartNumbersConstraint)
  @ValidateNested({ each: true })
  @Type(() => CompleteVideoUploadPartDto)
  parts: CompleteVideoUploadPartDto[];
}
